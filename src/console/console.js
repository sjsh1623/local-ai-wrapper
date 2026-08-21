/* Branchsmith console — reads /v1/jobs and /v1/stream, writes only /cancel. */
(function () {
  var app = document.getElementById('app');
  var L = 'ko';
  var jobs = [];
  var stats = { running: 0, queued: 0, done: 0, failed: 0 };
  var filter = 'all';
  var selected = null;
  var thread = { jobId: null, events: [], failedDeliveries: [] };

  var STAGES = ['queued','preparing','branching','planning','editing','verifying','committing','pushing','pr_opened'];
  var STAGE_LABEL = {
    queued:{ko:'접수',en:'accepted'}, preparing:{ko:'작업 공간',en:'workspace'},
    branching:{ko:'브랜치',en:'branch'}, planning:{ko:'맥락 수집',en:'context'},
    editing:{ko:'코드 수정',en:'editing'}, verifying:{ko:'검증',en:'verifying'},
    committing:{ko:'커밋',en:'commit'}, pushing:{ko:'푸시',en:'push'}, pr_opened:{ko:'PR 생성',en:'PR'}
  };
  var STATUS_LABEL = {
    running:{ko:'실행 중',en:'running'}, queued:{ko:'대기',en:'queued'},
    failed:{ko:'실패',en:'failed'}, timed_out:{ko:'시간 초과',en:'timed out'},
    cancelled:{ko:'취소됨',en:'cancelled'}, succeeded:{ko:'완료',en:'done'},
    no_changes:{ko:'변경 없음',en:'no change'}
  };
  var TERMINAL = ['succeeded','no_changes','failed','cancelled','timed_out'];
  var PILL = { running:'running', queued:'queued', failed:'failed', timed_out:'failed',
               cancelled:'failed', succeeded:'succeeded', no_changes:'succeeded' };

  /* SF Symbols 를 쓸 수 없으니 같은 규칙(둥근 캡, 1.9 스트로크)으로 직접 그린다. */
  var GLYPH = {
    run:   '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.2v4.2h-4.2"/>',
    queue: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 1.9"/>',
    done:  '<circle cx="12" cy="12" r="8.4"/><path d="M8.2 12.3l2.6 2.6 5-5.5"/>',
    fail:  '<path d="M12 4.4 2.8 19.6h18.4z"/><path d="M12 10v4.3"/><path d="M12 17.3h.01"/>'
  };
  function icon(name, size, cls) {
    return '<svg class="' + (cls || '') + '" width="' + size + '" height="' + size + '" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + GLYPH[name] + '</svg>';
  }

  function t(o) { return o ? (o[L] || o.en) : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  }
  function clock(iso) { return iso ? new Date(iso).toTimeString().slice(0, 8) : ''; }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function elapsedOf(job) {
    var from = job.startedAt || job.createdAt;
    var to = job.finishedAt ? new Date(job.finishedAt) : new Date();
    return (to - new Date(from)) / 1000;
  }
  function isTerminal(job) { return TERMINAL.indexOf(job.status) >= 0; }

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then(function (res) {
        if (res.status === 401) { location.href = '/console/login'; throw new Error('unauthorized'); }
        if (!res.ok) throw new Error(path + ' → ' + res.status);
        return res.json();
      });
  }

  /* ── rendering ─────────────────────────────────────────────── */

  function segs(job) {
    var idx = STAGES.indexOf(job.stage) + 1;
    var out = '';
    for (var i = 0; i < 9; i++) {
      var c = '';
      if (job.status === 'succeeded' || job.status === 'no_changes') c = 'on';
      else if (isTerminal(job) && i === idx - 1) c = 'bad';
      else if (i < idx - 1) c = 'on';
      else if (i === idx - 1) c = job.status === 'running' ? 'cur' : 'on';
      out += '<i class="' + c + '"></i>';
    }
    return out;
  }

  function renderStats() {
    var tiles = [
      { cls:'run',   ico:'run',   lbl:{ko:'실행 중',en:'Running'},        val:stats.running },
      { cls:'queue', ico:'queue', lbl:{ko:'대기',en:'Queued'},            val:stats.queued },
      { cls:'done',  ico:'done',  lbl:{ko:'오늘 완료',en:'Done today'},   val:stats.done },
      { cls:'fail',  ico:'fail',  lbl:{ko:'오늘 실패',en:'Failed today'}, val:stats.failed }
    ];
    document.getElementById('stats').innerHTML = tiles.map(function (s) {
      return '<div class="stat ' + s.cls + '">' + icon(s.ico, 16, 'ico') +
             '<span class="lbl">' + esc(t(s.lbl)) +
             '</span><span class="val">' + s.val + '</span></div>';
    }).join('');
  }

  function counts() {
    var c = { all: jobs.length, running: 0, queued: 0, failed: 0 };
    jobs.forEach(function (j) {
      if (j.status === 'running') c.running++;
      else if (j.status === 'queued') c.queued++;
      else if (j.status === 'failed' || j.status === 'timed_out') c.failed++;
    });
    return c;
  }

  function renderFilters() {
    var c = counts();
    var defs = [
      { f:'all',     lbl:{ko:'전체',en:'All'},     n:c.all },
      { f:'running', lbl:{ko:'실행',en:'Running'}, n:c.running },
      { f:'queued',  lbl:{ko:'대기',en:'Queued'},  n:c.queued },
      { f:'failed',  lbl:{ko:'실패',en:'Failed'},  n:c.failed }
    ];
    document.getElementById('filters').innerHTML = defs.map(function (d) {
      return '<button type="button" data-f="' + d.f + '" aria-pressed="' + (d.f === filter) +
             '">' + esc(t(d.lbl)) + '<span class="n">' + d.n + '</span></button>';
    }).join('');
    document.querySelectorAll('#filters button').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.dataset.f;
        var visible = visibleJobs();
        if (visible.length && !visible.some(function (j) { return j.id === selected; })) {
          select(visible[0].id);
        } else { renderFilters(); renderRows(); }
      });
    });
  }

  function visibleJobs() {
    return jobs.filter(function (j) {
      if (filter === 'all') return true;
      if (filter === 'failed') return j.status === 'failed' || j.status === 'timed_out';
      return j.status === filter;
    });
  }

  function renderRows() {
    var host = document.getElementById('rows');
    var list = visibleJobs();
    if (!list.length) {
      host.innerHTML = '<div class="empty"><b>' +
        (L === 'ko' ? '표시할 작업이 없습니다' : 'No jobs here') + '</b>' +
        (L === 'ko' ? '알럿이 들어오면 이 목록에 바로 나타납니다.'
                    : 'Alerts show up here the moment they arrive.') + '</div>';
      return;
    }
    host.innerHTML = list.map(function (j) {
      return '<button class="row" type="button" data-id="' + esc(j.id) + '" aria-current="' +
        (j.id === selected) + '">' +
        '<div class="r1"><span class="repo">' + esc(j.repo) + '</span>' +
        '<span class="pill ' + PILL[j.status] + '">' + esc(t(STATUS_LABEL[j.status])) + '</span></div>' +
        '<div class="alert">' + esc(j.context && j.context.alertname ? j.context.alertname : firstLine(j.instruction)) + '</div>' +
        '<div class="r3"><span class="mini">' + segs(j) + '</span>' +
        '<span class="el" data-id="' + esc(j.id) + '">' + fmt(elapsedOf(j)) + '</span></div></button>';
    }).join('');
    host.querySelectorAll('.row').forEach(function (b) {
      b.addEventListener('click', function () { select(b.dataset.id); });
    });
  }

  function firstLine(text) {
    var line = String(text || '').trim().split('\n')[0] || '';
    return line.length > 60 ? line.slice(0, 57) + '…' : line;
  }

  /** Classify one stored event into one of the timeline's visual kinds. */
  function kindOf(event) {
    if (event.status === 'failed') return 'error';
    if (event.stage === 'editing' && event.status === 'running') return 'tool';
    if (event.stage === 'pr_opened' && event.status === 'done') return 'result';
    if (event.data && event.data.dryRun) return 'result';
    return 'stage';
  }

  function bubble(kind, time, who, paragraphs, kv) {
    var kvHtml = kv && kv.length
      ? '<div class="kv">' + kv.map(function (x) {
          return '<span><b>' + esc(x.k) + '</b> ' + esc(x.v) + '</span>'; }).join('') + '</div>'
      : '';
    return '<div class="msg ' + kind + '"><div class="t">' + esc(time) + '</div>' +
      '<div class="c"><div class="who">' + esc(who) + '</div><div class="bubble">' +
      paragraphs.map(function (p) { return '<p>' + linkify(esc(p)) + '</p>'; }).join('') +
      kvHtml + '</div></div></div>';
  }

  function linkify(html) {
    return html.replace(/https?:\/\/[^\s<]+/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noreferrer noopener">' + u + '</a>';
    });
  }

  function renderThread() {
    var job = jobs.filter(function (j) { return j.id === selected; })[0];
    var head = document.getElementById('t-alert');
    if (!job) {
      head.textContent = L === 'ko' ? '작업을 선택하세요' : 'Select a job';
      document.getElementById('t-meta').innerHTML = '';
      var idle = document.getElementById('t-step');
      idle.className = 'island';
      idle.innerHTML = '';
      document.getElementById('t-msgs').innerHTML = '<div class="empty"><b>' +
        (L === 'ko' ? '선택된 작업이 없습니다' : 'Nothing selected') + '</b>' +
        (L === 'ko' ? '왼쪽 목록에서 작업을 고르면 진행 단계와 로그가 여기에 흐릅니다.'
                    : 'Pick a job on the left to follow its stages and log here.') + '</div>';
      document.getElementById('t-now').innerHTML = '';
      return;
    }

    head.textContent = job.context && job.context.alertname
      ? job.context.alertname : firstLine(job.instruction);

    document.getElementById('t-meta').innerHTML =
      '<span><b>' + esc(job.id) + '</b></span>' +
      '<span>' + esc(job.repo) + ' ← ' + esc(job.base) + '</span>' +
      (job.branch ? '<span>' + esc(job.branch) + '</span>' : '') +
      (job.flowPostId ? '<span>flow #' + esc(job.flowPostId) + '</span>' : '') +
      (job.dryRun ? '<span>dryRun</span>' : '') +
      (job.prUrl ? '<span><a href="' + esc(job.prUrl) + '" target="_blank" rel="noreferrer noopener">PR</a></span>' : '');

    var cancel = document.getElementById('t-cancel');
    cancel.disabled = isTerminal(job);

    // 진행 중인 작업 하나를 다이내믹 아일랜드처럼 띄운다: 지금 어느 단계인지,
    // 몇 번째인지, 얼마나 걸리고 있는지가 한 캡슐 안에 모두 들어간다.
    var idx = STAGES.indexOf(job.stage) + 1;
    var running = job.status === 'running';
    var ok = job.status === 'succeeded' || job.status === 'no_changes';
    var bad = isTerminal(job) && !ok;
    var island = document.getElementById('t-step');
    island.className = 'island' + (running ? ' live' : ok ? ' ok' : bad ? ' bad' : '');
    island.innerHTML =
      '<span class="ibadge">' +
        icon(running ? 'run' : ok ? 'done' : bad ? 'fail' : 'queue', 20) + '</span>' +
      '<div class="imain"><div class="itop">' +
        '<span class="istage">' + esc(job.status === 'queued'
          ? (L === 'ko' ? '큐에서 대기 중' : 'Waiting in queue')
          : t(STAGE_LABEL[job.stage])) + '</span>' +
        (job.status === 'queued' ? '' : '<span class="icount">' + idx + ' / 9</span>') +
        '<span class="el" data-id="' + esc(job.id) + '">' + fmt(elapsedOf(job)) + '</span>' +
      '</div><div class="irail">' + segs(job) + '</div></div>';

    var html = '';

    // The inbound alert is reconstructed from the job record: it is the one
    // message that came from outside, so the thread opens with it.
    var kv = [];
    Object.keys(job.context || {}).forEach(function (k) {
      if (k !== 'alertUrl') kv.push({ k: k, v: job.context[k] });
    });
    if (job.idempotencyKey) kv.push({ k: 'key', v: job.idempotencyKey });
    html += bubble(
      'inbound', clock(job.createdAt),
      L === 'ko' ? '받은 알럿' : 'Alert received',
      String(job.instruction || '').split('\n\n'), kv
    );

    thread.events.forEach(function (e) {
      html += bubble(kindOf(e), clock(e.ts), e.text.split(' — ')[0], [
        e.text.indexOf(' — ') >= 0 ? e.text.slice(e.text.indexOf(' — ') + 3) : ''
      ].filter(Boolean), kvOf(e));
    });

    thread.failedDeliveries.forEach(function (d) {
      html += bubble('notify', clock(d.ts),
        (L === 'ko' ? '알림 전송 실패' : 'Delivery failed') + ' · ' + d.transport,
        [d.error || ''], []);
    });

    document.getElementById('t-msgs').innerHTML = html;
    var msgs = document.getElementById('t-msgs');
    msgs.scrollTop = msgs.scrollHeight;

    var now = document.getElementById('t-now');
    if (job.status === 'running') {
      now.className = 'nowbar';
      now.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>' +
        esc(t(STAGE_LABEL[job.stage])) +
        (L === 'ko' ? ' 진행 중 — 다음 이벤트를 기다리는 중' : ' in progress — waiting on the next event') +
        '</span>';
    } else if (job.status === 'queued') {
      now.className = 'nowbar done';
      now.innerHTML = '<span>' + (L === 'ko'
        ? '큐에서 대기 중 — 앞 작업이 끝나면 자동으로 시작합니다.'
        : 'Waiting in the queue — starts automatically when the job ahead finishes.') + '</span>';
    } else {
      now.className = 'nowbar done';
      now.innerHTML = '<span>' + esc(t(STATUS_LABEL[job.status])) + ' · ' +
        (L === 'ko' ? '이벤트 ' + thread.events.length + '건' : thread.events.length + ' events') +
        (job.error ? ' · ' + esc(job.error) : '') + '</span>';
    }
  }

  function kvOf(e) {
    var out = [];
    var d = e.data || {};
    ['files','turns','sha','prNumber','branch'].forEach(function (k) {
      if (d[k] !== undefined && d[k] !== null) out.push({ k: k, v: d[k] });
    });
    return out;
  }

  /* ── data ──────────────────────────────────────────────────── */

  function select(id) {
    selected = id;
    renderFilters(); renderRows(); renderThread();
    api('/v1/jobs/' + encodeURIComponent(id) + '/log').then(function (data) {
      if (selected !== id) return;
      thread = { jobId: id, events: data.events, failedDeliveries: data.failedDeliveries || [] };
      var i = jobs.findIndex(function (j) { return j.id === id; });
      if (i >= 0) jobs[i] = data.job;
      renderThread();
    }).catch(function () {});
  }

  function refresh() {
    return api('/v1/jobs?limit=60').then(function (data) {
      jobs = data.jobs;
      stats = data.stats;
      if (!selected && jobs.length) { select(jobs[0].id); return; }
      renderStats(); renderFilters(); renderRows(); renderThread();
    });
  }

  function onEvent(event) {
    var job = jobs.filter(function (j) { return j.id === event.jobId; })[0];
    if (!job) { refresh(); return; }

    job.stage = event.stage;
    if (event.data && event.data.prUrl) job.prUrl = event.data.prUrl;
    if (event.data && event.data.branch) job.branch = event.data.branch;

    if (event.jobId === selected) {
      // Guard against the replay buffer re-delivering what we already have.
      if (!thread.events.some(function (e) { return e.seq === event.seq; })) {
        thread.events.push(event);
      }
      // The stored status is authoritative; a terminal event means refetching.
      if (event.status === 'failed' || event.stage === 'pr_opened') {
        api('/v1/jobs/' + encodeURIComponent(event.jobId)).then(function (fresh) {
          var i = jobs.findIndex(function (j) { return j.id === fresh.id; });
          if (i >= 0) jobs[i] = fresh;
          renderStats(); renderFilters(); renderRows(); renderThread();
        }).catch(function () {});
      }
    }
    renderRows(); renderThread();
  }

  function connect() {
    var source = new EventSource('/v1/stream', { withCredentials: true });
    var dot = document.querySelector('.live');
    source.addEventListener('job', function (msg) {
      try { onEvent(JSON.parse(msg.data)); } catch (e) {}
    });
    source.addEventListener('open', function () {
      if (dot) dot.style.color = '';
    });
    source.addEventListener('error', function () {
      // EventSource reconnects on its own; surface the gap rather than hide it.
      if (dot) dot.style.color = 'var(--red)';
    });
  }

  /* ── wiring ────────────────────────────────────────────────── */

  document.getElementById('t-cancel').addEventListener('click', function () {
    if (!selected) return;
    api('/v1/jobs/' + encodeURIComponent(selected) + '/cancel', { method: 'POST' })
      .then(refresh).catch(function () {});
  });

  document.querySelectorAll('.langswitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      L = b.dataset.lang;
      app.className = 'lang-' + L;
      document.querySelectorAll('.langswitch button').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.lang === L));
      });
      try { localStorage.setItem('branchsmith-lang', L); } catch (e) {}
      renderStats(); renderFilters(); renderRows(); renderThread();
    });
  });

  var saved = null;
  try { saved = localStorage.getItem('branchsmith-lang'); } catch (e) {}
  if (saved === 'en' || saved === 'ko') {
    L = saved;
    app.className = 'lang-' + L;
    document.querySelectorAll('.langswitch button').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.lang === L));
    });
  }

  refresh().then(connect).catch(function () { location.href = '/console/login'; });
  setInterval(function () {
    document.querySelectorAll('.el').forEach(function (el) {
      var job = jobs.filter(function (j) { return j.id === el.dataset.id; })[0];
      if (job && !job.finishedAt) el.textContent = fmt(elapsedOf(job));
    });
  }, 1000);
  setInterval(function () { refresh().catch(function () {}); }, 30000);
})();
