/* morningmate-alert console — reads /v1/jobs, /v1/stream and /v1/qa; writes only /cancel.
   (/v1/qa/poll re-reads the QA project — it changes nothing over there.) */
(function () {
  var app = document.getElementById('app');
  var L = 'ko';
  var jobs = [];
  var stats = { running: 0, queued: 0, done: 0, failed: 0 };
  var filter = 'all';
  var selected = null;
  var thread = { jobId: null, events: [], failedDeliveries: [] };

  /* 두 번째 보기. 작업(job)은 이 서비스가 맡은 일이고, QA 글은 읽어만 온 것이라
     목록도 선택도 따로 갖는다 — 보기를 오가도 서로의 선택을 잃지 않는다. */
  var view = 'jobs';
  var qa = { poller: null, projects: [], items: [] };
  /* 'all' · 상태 가족 '0'~'3' · 'gone'. 글은 담당자 기준으로 전부 가져오고 여기서 거른다. */
  var qaFilter = '0';
  var CATEGORY = {
    '0': { ko: '대기', en: 'Waiting' }, '1': { ko: '진행', en: 'In progress' },
    '2': { ko: '완료', en: 'Done' },   '3': { ko: '보류', en: 'On hold' }
  };
  /* 'all' 또는 프로젝트 번호. 여러 보드를 보되 한 번에 하나씩 읽는다. */
  var qaProject = 'all';
  var qaAvailable = null;   // 참여 프로젝트 목록. 패널을 열 때 받아온다.
  var qaSelected = null;
  var qaShown = null;
  var polling = false;
  /* 본문과 댓글은 글을 열 때 읽는다. 어느 글을 청했는지와 지금 읽는 중인지. */
  var detailRequested = null;
  var detailLoading = null;
  var LANE = {
    A1: { ko: '레이아웃 · 자동 수정', en: 'layout · auto-fix' },
    A2: { ko: '문구·다국어 · 코드 수정 + 키 목록', en: 'wording · code fix + key list' },
    B:  { ko: '로직 버그 · 분석 + 초안', en: 'logic bug · analysis + draft' },
    C:  { ko: '고객 데이터 · 조사만', en: 'customer data · investigate only' },
    D:  { ko: '사람 판단', en: 'a person decides' }
  };
  var CONF = { high: { ko: '확신 높음', en: 'high' }, medium: { ko: '확신 중간', en: 'medium' }, low: { ko: '확신 낮음', en: 'low' } };

  function triageState(item) {
    var t = qa.triage || { queued: [], running: null };
    if (t.running === item.postId) return 'running';
    if (t.queued.indexOf(item.postId) >= 0) return 'queued';
    return null;
  }
  function laneBadge(item) {
    var r = item.review;
    if (r) {
      return '<span class="lane human ' + esc(r.lane) + '" title="' +
        esc((L === 'ko' ? '사람 판정 ' : 'reviewed: ') + t(LANE[r.lane]) + (r.by ? ' · ' + r.by : '') +
            (r.agentLane && r.agentLane !== r.lane ? (L === 'ko' ? ' · 에이전트는 ' : ' · agent said ') + r.agentLane : '')) +
        '">' + esc(r.lane) + '</span>';
    }
    var v = item.triage;
    if (!v) return '';
    var stale = v.version !== item.version;
    return '<span class="lane ' + esc(v.lane) + (v.confidence === 'low' ? ' low' : '') + (stale ? ' stale' : '') +
      '" title="' + esc(t(LANE[v.lane]) + ' · ' + t(CONF[v.confidence]) + (stale ? (L === 'ko' ? ' · 글이 바뀐 뒤의 판정 아님' : ' · made before the post changed') : '')) +
      '">' + esc(v.lane) + '</span>';
  }

  /* 사람 판정 한 줄. 저장된 게 있으면 결과와 "지우기", 없으면 맞음/레인 버튼과 메모 칸. */
  function reviewRow(item) {
    var r = item.review;
    var html = '<div class="review">';
    if (r) {
      html += '<div class="rdone">' + laneBadge(item) + '<b>' + esc(t(LANE[r.lane])) + '</b>' +
        (r.agentLane ? '<span class="pill ' + (r.agentLane === r.lane ? 'c2' : 'c0') + '">' +
          (r.agentLane === r.lane ? (L === 'ko' ? '에이전트와 일치' : 'agrees with agent')
                                  : (L === 'ko' ? '에이전트는 ' + r.agentLane : 'agent said ' + r.agentLane)) + '</span>' : '') +
        (r.note ? '<span>' + esc(r.note) + '</span>' : '') +
        '<span class="rm">' + esc(r.by || '—') + ' · ' + clock(r.at) + '</span>' +
        '<button type="button" class="clear" data-clear="' + esc(item.postId) + '">' + (L === 'ko' ? '지우기' : 'clear') + '</button>' +
        '</div>';
    } else {
      var agent = item.triage ? item.triage.lane : null;
      html += '<div class="rq">' + (agent
        ? (L === 'ko' ? '이 판정이 맞나요?' : 'Is this right?')
        : (L === 'ko' ? '사람이 레인을 지정' : 'Set the lane yourself')) + '</div>' +
        '<div class="rrow">' +
        (agent ? '<button type="button" class="ok" data-lane="' + esc(agent) + '">' + (L === 'ko' ? '맞음 (' + agent + ')' : 'Yes (' + agent + ')') + '</button>' : '') +
        ['A1', 'A2', 'B', 'C', 'D'].filter(function (l) { return l !== agent; }).map(function (l) {
          return '<button type="button" data-lane="' + l + '" title="' + esc(t(LANE[l])) + '">' + l + '</button>';
        }).join('') +
        '<input class="note" id="rv-note" placeholder="' + (L === 'ko' ? '이유 (선택)' : 'why (optional)') + '">' +
        '<input class="by" id="rv-by" placeholder="' + (L === 'ko' ? '이름' : 'name') + '" value="' + esc(reviewerName()) + '">' +
        '</div>';
    }
    return html + '</div>';
  }
  function reviewerName() {
    try { return localStorage.getItem('morningmate-alert-reviewer') || ''; } catch (e) { return ''; }
  }
  function sendReview(postId, lane) {
    var note = (document.getElementById('rv-note') || {}).value || '';
    var by = (document.getElementById('rv-by') || {}).value || '';
    try { localStorage.setItem('morningmate-alert-reviewer', by); } catch (e) {}
    api('/v1/qa/items/' + encodeURIComponent(postId) + '/review', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lane: lane, note: note, by: by })
    }).then(applyItem).catch(function () {});
  }
  function clearReview(postId) {
    api('/v1/qa/items/' + encodeURIComponent(postId) + '/review', { method: 'DELETE' })
      .then(applyItem).catch(function () {});
  }
  function applyItem(d) {
    var i = qa.items.findIndex(function (x) { return x.postId === d.item.postId; });
    if (i >= 0) qa.items[i] = d.item;
    renderRows(); renderQaThread();
  }

  /* Must stay in the same order as STAGES in src/types.ts — the progress bar
     indexes into it, so a stage missing here silently renders as step 0. */
  var STAGES = ['queued','triaging','registering','preparing','branching','analyzing','editing','verifying','committing','pushing','pr_opened'];
  var STAGE_LABEL = {
    queued:{ko:'접수',en:'accepted'}, triaging:{ko:'이슈 정리',en:'triage'},
    registering:{ko:'업무 등록',en:'task'}, preparing:{ko:'작업 공간',en:'workspace'},
    branching:{ko:'브랜치',en:'branch'}, analyzing:{ko:'원인 분석',en:'root cause'},
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
        if (!res.ok) {
          // 서버가 보낸 이유("프로젝트를 읽을 수 없음" 등)를 상태 코드 뒤에 숨기지 않는다.
          return res.json().catch(function () { return {}; }).then(function (body) {
            throw new Error(body && body.error ? body.error : path + ' → ' + res.status);
          });
        }
        return res.json();
      });
  }

  /* ── rendering ─────────────────────────────────────────────── */

  function segs(job) {
    var idx = STAGES.indexOf(job.stage) + 1;
    var out = '';
    for (var i = 0; i < STAGES.length; i++) {
      var c = '';
      if (job.status === 'succeeded' || job.status === 'no_changes') c = 'on';
      else if (isTerminal(job) && i === idx - 1) c = 'bad';
      else if (i < idx - 1) c = 'on';
      else if (i === idx - 1) c = job.status === 'running' ? 'cur' : 'on';
      out += '<i class="' + c + '"></i>';
    }
    return out;
  }

  function applyClass() { app.className = 'lang-' + L + ' view-' + view; }

  /* Flow 의 yyyyMMddHHmmss. 어느 시간대인지 API 가 말해주지 않으므로 변환하지 않고
     적힌 그대로 끊어 보여준다. */
  function stamp(s) {
    s = String(s || '');
    return s.length >= 12 ? s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12) : s;
  }

  /* 시간 칸은 52px 라 날짜와 시각을 두 줄로 나눈다. 댓글이 며칠에 걸치는 글에서
     시각만 보이면 순서를 읽을 수 없다. */
  function when(s) {
    var v = stamp(s);
    return v.length === 11 ? esc(v.slice(0, 5)) + '<br>' + esc(v.slice(6)) : esc(v);
  }

  function renderViews() {
    var defs = [
      { v:'jobs', lbl:{ko:'장애/경고 알림',en:'Alerts'}, n:jobs.length },
      { v:'qa',   lbl:{ko:'고객 QA',en:'Customer QA'}, n:waitingCount() }
    ];
    document.getElementById('views').innerHTML = defs.map(function (d) {
      return '<button type="button" role="tab" data-v="' + d.v + '" aria-pressed="' + (d.v === view) +
             '">' + esc(t(d.lbl)) + '<span class="n">' + d.n + '</span></button>';
    }).join('');
    document.querySelectorAll('#views button').forEach(function (b) {
      b.addEventListener('click', function () {
        view = b.dataset.v;
        qaShown = null;
        try { localStorage.setItem('morningmate-alert-view', view); } catch (e) {}
        applyClass();
        renderAll();
        if (view === 'qa') refreshQa().catch(function () {});
      });
    });
  }

  function renderAll() { renderViews(); renderStats(); renderFilters(); renderRows(); renderThread(); }

  function renderStats() {
    if (view === 'qa') { renderQaStats(); return; }
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
    if (view === 'qa') { renderQaFilters(); return; }
    document.getElementById('filters').className = 'seg filters';
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
    if (view === 'qa') { renderQaRows(); return; }
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
        (j.id === selected) + '" title="' + esc(webhookSummary(j)) + '">' +
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
    if ((event.stage === 'editing' || event.stage === 'analyzing') && event.status === 'running') return 'tool';
    if (event.stage === 'pr_opened' && event.status === 'done') return 'result';
    if (event.data && event.data.dryRun) return 'result';
    return 'stage';
  }

  function bubble(kind, time, who, paragraphs, kv, extra) {
    var kvHtml = kv && kv.length
      ? '<div class="kv">' + kv.map(function (x) {
          return '<span><b>' + esc(x.k) + '</b> ' + esc(x.v) + '</span>'; }).join('') + '</div>'
      : '';
    return '<div class="msg ' + kind + '"><div class="t">' + esc(time) + '</div>' +
      '<div class="c"><div class="who">' + esc(who) + '</div><div class="bubble">' +
      paragraphs.map(function (p) { return '<p>' + linkify(esc(p)) + '</p>'; }).join('') +
      kvHtml + (extra || '') + '</div></div></div>';
  }

  /**
   * What arrived, in the order someone asks about it: what fired, how bad, where
   * from, and where it is being sent. Rendered into a title attribute so it works
   * inside the scrolling list — a positioned hover card gets clipped by the very
   * overflow that makes the list scrollable.
   */
  function webhookSummary(job) {
    var c = job.context || {};
    var lines = [(L === 'ko' ? '수신 웹훅' : 'Inbound webhook') + ' · ' + (c.source || '—')];
    // Every field the adapter kept, in the order it kept them — a fixed list
    // here would hide exactly the label that explains an unfamiliar alert
    // (host.name, mountpoint, threshold.name). `source` is already in the
    // heading, alertUrl is rendered as a link below, and `_`-prefixed keys hold
    // the raw body that has its own foldaway block.
    Object.keys(c).forEach(function (k) {
      if (k === 'source' || k === 'alertUrl' || k.charAt(0) === '_') return;
      if (c[k]) lines.push(k + ': ' + c[k]);
    });
    lines.push('repo: ' + job.repo + ' (' + job.base + ')' + (job.dryRun ? ' · dryRun' : ''));
    if (c.alertUrl) lines.push(c.alertUrl);
    var first = firstLine(job.instruction);
    if (first) lines.push('', first);
    return lines.join('\n');
  }

  /** The webhook exactly as it arrived, folded away until someone wants it. */
  function rawBlock(job) {
    var raw = job.context && job.context._raw;
    if (!raw) return '';
    var pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { /* 원문 그대로 */ }
    return '<details class="raw"><summary>' +
      (L === 'ko' ? 'SigNoz 에서 온 원본 웹훅' : 'Raw webhook from SigNoz') +
      '</summary><pre>' + esc(pretty) + '</pre></details>';
  }

  function linkify(html) {
    return html.replace(/https?:\/\/[^\s<]+/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noreferrer noopener">' + u + '</a>';
    });
  }

  function renderThread() {
    if (view === 'qa') { renderQaThread(); return; }
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
      (job.flowTaskId
        ? '<span>' + (job.flowUrl
            ? '<a href="' + esc(job.flowUrl) + '" target="_blank" rel="noreferrer noopener">flow #' + esc(job.flowTaskId) + '</a>'
            : 'flow #' + esc(job.flowTaskId)) + '</span>'
        : '') +
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
      if (k !== 'alertUrl' && k.charAt(0) !== '_') kv.push({ k: k, v: job.context[k] });
    });
    if (job.idempotencyKey) kv.push({ k: 'key', v: job.idempotencyKey });
    html += bubble(
      'inbound', clock(job.createdAt),
      L === 'ko' ? '받은 알럿' : 'Alert received',
      String(job.instruction || '').split('\n\n'), kv, rawBlock(job)
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

  /* ── QA 대기 ───────────────────────────────────────────────── */

  function inProject(i) { return qaProject === 'all' || i.projectId === qaProject; }
  function matchesFilter(i, f) {
    if (f === 'gone') return i.state === 'gone';
    if (i.state !== 'open') return false;
    return f === 'all' || i.statusCategory === f;
  }
  function visibleQa() {
    return qa.items.filter(function (i) { return inProject(i) && matchesFilter(i, qaFilter); });
  }
  function waitingCount() {
    return qa.items.filter(function (i) { return i.state === 'open' && i.statusCategory === '0'; }).length;
  }

  function projectTitle(id) {
    var p = qa.projects.filter(function (x) { return x.projectId === id; })[0];
    return p && p.title ? p.title : '#' + id;
  }

  function renderQaProjects() {
    var sel = document.getElementById('qa-project');
    // 괄호 안은 대기 중인 글 수 — 사람이 봐야 할 것의 수다
    var opts = [{ v: 'all', label: (L === 'ko' ? '전체 프로젝트' : 'All projects') + ' (' + waitingCount() + ')' }];
    qa.projects.forEach(function (p) {
      opts.push({ v: p.projectId, label: (p.title || '#' + p.projectId) + ' (' + (p.waiting || 0) + ')' });
    });
    if (!opts.some(function (o) { return o.v === qaProject; })) qaProject = 'all';
    sel.innerHTML = opts.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (o.v === qaProject ? ' selected' : '') + '>' +
             esc(o.label) + '</option>';
    }).join('');
  }

  function renderQaPanel() {
    var mine = document.getElementById('qa-pmine');
    mine.innerHTML = qa.projects.length ? qa.projects.map(function (p) {
      return '<div class="pitem"><span class="pt">' + esc(p.title || '#' + p.projectId) +
        '</span><span class="pid">' + esc(p.projectId) + '</span>' +
        '<button type="button" class="del" data-id="' + esc(p.projectId) + '">' +
        (L === 'ko' ? '제거' : 'Remove') + '</button></div>';
    }).join('') : '<div class="empty">' + (L === 'ko' ? '아직 없습니다' : 'None yet') + '</div>';
    mine.querySelectorAll('button.del').forEach(function (b) {
      // 확인 창 대신 두 번 누르기: 첫 클릭은 색만 바꾸고, 4초 안의 두 번째 클릭이 지운다.
      b.addEventListener('click', function () {
        if (!b.classList.contains('arm')) {
          b.classList.add('arm');
          b.textContent = L === 'ko' ? '한 번 더 누르면 제거' : 'Click again to remove';
          setTimeout(function () {
            b.classList.remove('arm');
            b.textContent = L === 'ko' ? '제거' : 'Remove';
          }, 4000);
          return;
        }
        b.disabled = true;
        api('/v1/qa/projects/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' })
          .then(function () { if (qaProject === b.dataset.id) qaProject = 'all'; return refreshQa(); })
          .then(function () { renderQaPanel(); })
          .catch(function (e) { note(String(e)); b.disabled = false; });
      });
    });

    var list = document.getElementById('qa-plist');
    if (qaAvailable === null) {
      list.innerHTML = '<div class="empty">' + (L === 'ko' ? '불러오는 중…' : 'Loading…') + '</div>';
      return;
    }
    var added = {};
    qa.projects.forEach(function (p) { added[p.projectId] = true; });
    var rest = qaAvailable.filter(function (p) { return !added[p.projectId]; });
    list.innerHTML = rest.length ? rest.map(function (p) {
      return '<div class="pitem"><span class="pt">' + esc(p.title || '#' + p.projectId) + '</span>' +
        '<span class="pid">' + esc(p.projectId) + '</span>' +
        '<button type="button" class="add" data-id="' + esc(p.projectId) + '">' +
        (L === 'ko' ? '추가' : 'Add') + '</button></div>';
    }).join('') : '<div class="empty">' + (L === 'ko' ? '추가할 프로젝트가 없습니다' : 'Nothing left to add') + '</div>';
    list.querySelectorAll('button.add').forEach(function (b) {
      b.addEventListener('click', function () { addProject(b.dataset.id, b); });
    });
  }

  function note(text) { document.getElementById('qa-pnote').textContent = text || ''; }

  function addProject(id, button) {
    if (!/^\d{1,15}$/.test(id)) { note(L === 'ko' ? '프로젝트 번호는 숫자입니다' : 'A project id is a number'); return; }
    note('');
    if (button) button.disabled = true;
    api('/v1/qa/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: id })
    }).then(function () {
      qaProject = id;
      try { localStorage.setItem('morningmate-alert-qa-project', qaProject); } catch (e) {}
      document.getElementById('qa-pid').value = '';
      return refreshQa();
    }).then(function () { renderQaPanel(); })
      .catch(function (e) {
        note(String(e && e.message || e));
        if (button) button.disabled = false;
      });
  }

  function openQaPanel(open) {
    var panel = document.getElementById('qa-panel');
    var btn = document.getElementById('qa-add');
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '×' : '+';
    if (!open) return;
    renderQaPanel();
    api('/v1/qa/projects/available').then(function (d) {
      qaAvailable = d.projects || [];
      renderQaPanel();
    }).catch(function (e) { qaAvailable = []; renderQaPanel(); note(String(e)); });
  }

  function renderQaStats() {
    // 상태 가족별 건수. 수집 계정이 담당인 글 전체를 네 칸으로 나눈 것이다.
    var n = { '0': 0, '1': 0, '2': 0, '3': 0 };
    qa.items.forEach(function (i) {
      if (i.state === 'open' && n[i.statusCategory] !== undefined) n[i.statusCategory]++;
    });
    var last = (qa.poller && qa.poller.last) || {};
    var tiles = [
      { cls:'queue', ico:'queue', lbl:CATEGORY['0'], val:n['0'] },
      { cls:'run',   ico:'run',   lbl:CATEGORY['1'], val:n['1'] },
      { cls:'done',  ico:'done',  lbl:CATEGORY['2'], val:n['2'] },
      last.failed
        ? { cls:'fail', ico:'fail', lbl:{ko:'읽지 못한 글',en:'Could not read'}, val:last.failed }
        : { cls:'',     ico:'queue', lbl:CATEGORY['3'], val:n['3'] }
    ];
    document.getElementById('stats').innerHTML = tiles.map(function (s) {
      return '<div class="stat ' + s.cls + '">' + icon(s.ico, 16, 'ico') +
             '<span class="lbl">' + esc(t(s.lbl)) + '</span><span class="val">' +
             (s.val === undefined || s.val === null ? '—' : s.val) + '</span></div>';
    }).join('');
  }

  function renderQaFilters() {
    renderQaProjects();
    var scoped = qa.items.filter(inProject);
    var count = function (f) { return scoped.filter(function (i) { return matchesFilter(i, f); }).length; };
    var defs = [
      { f:'all',  lbl:{ko:'전체',en:'All'},        n:count('all') },
      { f:'0',    lbl:CATEGORY['0'],               n:count('0') },
      { f:'1',    lbl:CATEGORY['1'],               n:count('1') },
      { f:'2',    lbl:CATEGORY['2'],               n:count('2') },
      { f:'3',    lbl:CATEGORY['3'],               n:count('3') },
      { f:'gone', lbl:{ko:'담당 해제',en:'Left'},  n:count('gone') }
    ];
    document.getElementById('filters').className = 'seg filters wrap';
    document.getElementById('filters').innerHTML = defs.map(function (d) {
      return '<button type="button" data-f="' + d.f + '" aria-pressed="' + (d.f === qaFilter) +
             '">' + esc(t(d.lbl)) + '<span class="n">' + d.n + '</span></button>';
    }).join('');
    document.querySelectorAll('#filters button').forEach(function (b) {
      b.addEventListener('click', function () {
        qaFilter = b.dataset.f;
        var visible = visibleQa();
        if (!visible.some(function (i) { return i.postId === qaSelected; })) {
          qaSelected = visible.length ? visible[0].postId : null;
        }
        renderAll();
      });
    });
  }

  /* 폴러가 꺼져 있을 때 빈 목록만 보여주면 "글이 없다"로 읽힌다. 무엇이 비어서
     꺼져 있는지를 그 자리에서 말해준다. */
  function qaOffReason() {
    var p = qa.poller;
    if (!p || p.enabled) return '';
    return (L === 'ko' ? 'QA 수집이 꺼져 있습니다 — ' : 'QA intake is off — ') + (p.reason || '');
  }

  function renderQaRows() {
    var host = document.getElementById('rows');
    var list = visibleQa();
    if (!list.length) {
      var off = qaOffReason();
      host.innerHTML = '<div class="empty"><b>' +
        (off ? esc(off) : (L === 'ko' ? '표시할 QA 글이 없습니다' : 'No QA posts here')) + '</b>' +
        (off ? (L === 'ko' ? '.env 의 QA_* 값을 채우고 서버를 다시 시작하세요.'
                           : 'Fill in the QA_* values in .env and restart.')
             : (L === 'ko' ? '담당자가 수집 계정인 글이 상태별로 여기에 나타납니다.'
                           : 'Posts assigned to the intake account show up here, by status.')) +
        '</div>';
      return;
    }
    host.innerHTML = list.map(function (i) {
      var tags = [];
      Object.keys(i.columns || {}).forEach(function (k) {
        (i.columns[k] || []).forEach(function (v) { tags.push(v); });
      });
      if (i.images && i.images.length) tags.push((L === 'ko' ? '이미지 ' : 'images ') + i.images.length);
      if (i.hasVideo) tags.push(L === 'ko' ? '영상' : 'video');
      return '<button class="row" type="button" data-id="' + esc(i.postId) + '" aria-current="' +
        (i.postId === qaSelected) + '">' +
        '<div class="r1"><span class="repo">' +
        (qaProject === 'all' ? esc(projectTitle(i.projectId)) + ' · ' : '') +
        '#' + esc(i.postId) + ' · ' + esc(stamp(i.registeredAt)) + '</span>' +
        '<span class="pill ' + (i.state === 'gone' ? 'gone' : 'c' + esc(i.statusCategory)) + '">' +
        esc(i.statusName || i.statusId) + '</span></div>' +
        '<div class="alert">' + laneBadge(i) + esc(i.title) + '</div>' +
        (tags.length ? '<div class="tags">' + tags.slice(0, 6).map(function (x) {
          return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
        '</button>';
    }).join('');
    host.querySelectorAll('.row').forEach(function (b) {
      b.addEventListener('click', function () {
        // 이미 열린 글을 다시 누르면 본문과 댓글을 다시 읽는다
        if (qaSelected === b.dataset.id) detailRequested = null;
        qaSelected = b.dataset.id;
        renderAll();
      });
    });
  }

  /* group 은 같은 말풍선의 사진들을 한 묶음으로 묶는 이름이다 — 라이트박스의
     좌우 이동은 그 묶음 안에서만 돈다. 본문 사진 다음에 댓글 사진이 이어지면
     어느 글에서 온 사진인지 알 수 없게 된다. */
  function loadDetail(postId) {
    detailLoading = postId;
    api('/v1/qa/items/' + encodeURIComponent(postId) + '/open', { method: 'POST' })
      .then(function (d) {
        var i = qa.items.findIndex(function (x) { return x.postId === postId; });
        if (i >= 0 && d.item) qa.items[i] = d.item;
      })
      .catch(function () {})
      .then(function () { detailLoading = null; if (view === 'qa') { renderRows(); renderQaThread(); } });
  }

  function shots(urls, group) {
    if (!urls || !urls.length) return '';
    return '<div class="shots">' + urls.map(function (u) {
      // http(s) 만 통과시킨다 — 글 작성자가 넣은 주소가 그대로 속성에 들어가기 때문이다.
      if (!/^https?:\/\//.test(u)) return '';
      return '<a href="' + esc(u) + '" class="shot" data-src="' + esc(u) + '" data-group="' + esc(group) + '">' +
             '<img src="' + esc(u) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></a>';
    }).join('') + '</div>';
  }

  function renderQaThread() {
    var item = qa.items.filter(function (i) { return i.postId === qaSelected; })[0];
    var head = document.getElementById('t-alert');
    var island = document.getElementById('t-step');
    island.className = 'island';
    island.innerHTML = '';

    var poll = document.getElementById('t-poll');
    var busy = polling || Boolean(qa.poller && qa.poller.running);
    poll.disabled = busy || !(qa.poller && qa.poller.enabled);

    var now = document.getElementById('t-now');
    var p = qa.poller || {};
    now.className = 'nowbar done';
    now.innerHTML = '<span>' + esc(
      !p.enabled ? qaOffReason()
      : busy ? (L === 'ko' ? 'QA 프로젝트를 다시 읽는 중…' : 'Re-reading the QA projects…')
      : (L === 'ko' ? '마지막 확인 ' : 'Last checked ') + (p.lastRunAt ? clock(p.lastRunAt) : '—') +
        ' · ' + (L === 'ko' ? Math.round(p.intervalMs / 60000) + '분마다' : 'every ' + Math.round(p.intervalMs / 60000) + ' min') +
        (p.lastError ? ' · ' + p.lastError : '')
    ) + '</span>';

    var open = document.getElementById('t-open');
    open.hidden = !item;
    if (item) open.href = item.url;
    var tri = document.getElementById('t-triage');
    tri.hidden = !item;
    if (item) {
      var ts = triageState(item);
      tri.disabled = Boolean(ts) || !(qa.poller && qa.poller.enabled);
      tri.querySelector('.ko').textContent = ts === 'running' ? '분류 중…' : ts === 'queued' ? '분류 대기 중' : item.triage ? '다시 분류' : '분류하기';
      tri.querySelector('.en').textContent = ts === 'running' ? 'Triaging…' : ts === 'queued' ? 'Queued' : item.triage ? 'Triage again' : 'Triage';
    }

    if (!item) {
      qaShown = null;
      head.textContent = L === 'ko' ? 'QA 글을 선택하세요' : 'Select a QA post';
      document.getElementById('t-meta').innerHTML = '';
      document.getElementById('t-msgs').innerHTML = '<div class="empty"><b>' +
        (L === 'ko' ? '선택된 글이 없습니다' : 'Nothing selected') + '</b>' +
        (L === 'ko' ? '왼쪽 목록에서 글을 고르면 본문과 댓글이 여기에 나옵니다.'
                    : 'Pick a post on the left to read it and its comments here.') + '</div>';
      return;
    }

    head.textContent = item.title;
    document.getElementById('t-meta').innerHTML =
      '<span><a href="' + esc(item.url) + '" target="_blank" rel="noreferrer noopener">#' + esc(item.postId) + '</a></span>' +
      '<span><b>' + esc(item.statusName || item.statusId) + '</b></span>' +
      (item.section ? '<span>' + esc(item.section) + '</span>' : '') +
      ((item.assignees || []).length
        ? '<span>' + esc(item.assignees.map(function (a) { return a.name || a.id; }).join(', ')) + '</span>'
        : '') +
      (item.state === 'gone' ? '<span>' + (L === 'ko' ? '담당 해제됨' : 'no longer assigned') + '</span>' : '');

    var kv = [];
    Object.keys(item.columns || {}).forEach(function (k) {
      kv.push({ k: k, v: (item.columns[k] || []).join(', ') });
    });
    (item.attachments || []).forEach(function (a) {
      kv.push({ k: L === 'ko' ? '첨부' : 'file', v: a.name || '?' });
    });

    // 처음 여는 글, 다시 누른 글, 또는 읽은 뒤 바뀐 글(판이 다름)은 읽어 온다.
    if (detailRequested !== item.postId || (item.detailVersion && item.detailVersion !== item.version && detailLoading !== item.postId)) {
      detailRequested = item.postId;
      loadDetail(item.postId);
    }

    // 30초마다 목록을 다시 받아오지만, 같은 글의 같은 판이면 본문을 다시 그리지
    // 않는다 — 읽고 있던 스크롤 위치가 매번 맨 위로 돌아가기 때문이다.
    var key = [item.postId, item.version, item.detailAt, detailLoading === item.postId,
               triageState(item), item.triage && item.triage.at, item.triageError,
               item.review && item.review.at, L].join('|');
    if (qaShown === key) return;
    qaShown = key;

    var loading = detailLoading === item.postId;
    var bodyText = item.detailAt
      ? (item.body || (L === 'ko' ? '(본문 없음)' : '(no body)'))
      : (L === 'ko' ? '본문을 불러오는 중…' : 'Loading the post…');
    var html = '<div class="msg inbound"><div class="t">' + when(item.registeredAt) + '</div>' +
      '<div class="c"><div class="who">' + esc(item.registerName || '—') + '</div><div class="bubble">' +
      '<p class="pre">' + linkify(esc(bodyText)) + '</p>' +
      (kv.length ? '<div class="kv">' + kv.map(function (x) {
        return '<span><b>' + esc(x.k) + '</b> ' + esc(x.v) + '</span>'; }).join('') + '</div>' : '') +
      shots(item.images, 'post') + '</div></div></div>';

    // 분류 결과. 판정은 글 바로 아래, 댓글보다 앞에 — 읽는 사람이 먼저 보는 것이 결론이다.
    var ts = triageState(item);
    if (item.detailAt) {
      var v = item.triage;
      var stale = v && v.version !== item.version;
      html += '<div class="msg result"><div class="t"></div><div class="c"><div class="who">' +
        (L === 'ko' ? '분류' : 'Triage') + '</div><div class="verdict">';
      if (!ts && !v && !item.triageError) {
        html += '<div class="vh"><b>' + (L === 'ko' ? '아직 분류하지 않았습니다' : 'Not triaged yet') + '</b>' +
          '<span class="vm">' + (L === 'ko' ? '위의 "분류하기"로 에이전트 판정을 받거나, 아래에서 직접 지정' : 'press "Triage" above, or set the lane below') + '</span></div>';
      }
      if (ts) {
        html += '<div class="vh"><b>' + (ts === 'running'
          ? (L === 'ko' ? '에이전트가 읽는 중…' : 'The agent is reading…')
          : (L === 'ko' ? '차례를 기다리는 중' : 'Waiting its turn')) + '</b></div>';
      }
      if (v) {
        html += '<div class="vh">' + laneBadge(item) + '<b>' + esc(t(LANE[v.lane])) + '</b>' +
          '<span class="pill ' + (v.confidence === 'high' ? 'c2' : v.confidence === 'medium' ? 'c1' : 'c3') + '">' + esc(t(CONF[v.confidence])) + '</span>' +
          '<span class="vm">' + esc(v.provider) + ' · ' + Math.round(v.elapsedMs / 1000) + 's · ' + clock(v.at) + '</span></div>' +
          (stale ? '<div class="vt">' + (L === 'ko' ? '⚠ 글이 바뀐 뒤의 판정이 아닙니다 — 다시 분류하세요' : '⚠ Made before the post changed — triage again') + '</div>' : '') +
          '<p class="pre">' + esc(v.summary) + '</p>' +
          (v.reasons.length ? '<div class="vt">' + (L === 'ko' ? '근거' : 'Why') + '</div><ul>' + v.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
          (v.missing.length ? '<div class="vt">' + (L === 'ko' ? '부족한 것' : 'Missing') + '</div><ul>' + v.missing.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '');
      }
      if (item.triageError && !ts) {
        html += '<div class="vt" style="color:var(--red)">' + (L === 'ko' ? '마지막 시도 실패: ' : 'Last attempt failed: ') + esc(item.triageError) + '</div>';
      }
      html += reviewRow(item);
      html += '</div></div></div>';
    }

    // 댓글 머리: 몇 건을 언제 읽었는지. 읽는 중이면 그렇다고 적는다.
    html += '<div class="msg notify"><div class="t"></div><div class="c"><div class="bubble"><p>' +
      (loading
        ? (L === 'ko' ? '본문과 댓글을 불러오는 중…' : 'Loading the post and its comments…')
        : item.detailAt
          ? (L === 'ko' ? '댓글 ' + (item.comments || []).length + '건 · ' + clock(item.detailAt) + ' 기준 · 글을 다시 누르면 새로 읽습니다'
                        : (item.comments || []).length + ' comments · as of ' + clock(item.detailAt) + ' · click the post again to re-read')
          : (L === 'ko' ? '아직 읽지 않았습니다' : 'Not read yet')) +
      '</p></div></div></div>';

    (item.comments || []).forEach(function (c) {
      html += '<div class="msg ' + (c.system ? 'notify' : 'stage') + '"><div class="t">' +
        when(c.at) + '</div><div class="c"><div class="who">' + esc(c.authorName || '—') +
        '</div><div class="bubble"><p class="pre">' + linkify(esc(c.text)) + '</p>' +
        shots(c.images, 'c' + c.id) + '</div></div></div>';
    });

    document.getElementById('t-msgs').innerHTML = html;
    document.querySelectorAll('#t-msgs .review button[data-lane]').forEach(function (b) {
      b.addEventListener('click', function () { sendReview(item.postId, b.dataset.lane); });
    });
    document.querySelectorAll('#t-msgs .review button[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () { clearReview(b.dataset.clear); });
    });
    document.querySelectorAll('#t-msgs a.shot').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var siblings = Array.prototype.slice.call(
          document.querySelectorAll('#t-msgs a.shot[data-group="' + a.dataset.group + '"]'));
        openLightbox(siblings.map(function (x) { return x.dataset.src; }), siblings.indexOf(a));
      });
    });
  }

  /* ── 이미지 크게 보기 ──────────────────────────────────────── */

  var lb = { urls: [], at: 0 };

  function showLightbox() {
    var src = lb.urls[lb.at];
    document.getElementById('lb-img').src = src;
    document.getElementById('lb-open').href = src;
    document.getElementById('lb-count').textContent =
      lb.urls.length > 1 ? (lb.at + 1) + ' / ' + lb.urls.length : '';
  }
  function openLightbox(urls, at) {
    lb = { urls: urls, at: at < 0 ? 0 : at };
    var box = document.getElementById('lightbox');
    box.classList.toggle('multi', urls.length > 1);
    showLightbox();
    box.setAttribute('open', '');
  }
  function closeLightbox() {
    var box = document.getElementById('lightbox');
    box.removeAttribute('open');
    document.getElementById('lb-img').src = '';
  }
  function stepLightbox(delta) {
    if (lb.urls.length < 2) return;
    // 끝에서 한 번 더 누르면 반대쪽 끝으로 — 사진이 두세 장일 때 가장 덜 어색하다.
    lb.at = (lb.at + delta + lb.urls.length) % lb.urls.length;
    showLightbox();
  }
  document.getElementById('lightbox').addEventListener('click', function (ev) {
    // 바탕이나 이미지를 누르면 닫히고, 상단 버튼과 좌우 화살표는 제 역할을 한다.
    if (ev.target.closest('.lbbar') || ev.target.closest('.lbnav')) return;
    closeLightbox();
  });
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', function () { stepLightbox(-1); });
  document.getElementById('lb-next').addEventListener('click', function () { stepLightbox(1); });
  document.addEventListener('keydown', function (ev) {
    if (!document.getElementById('lightbox').hasAttribute('open')) return;
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowLeft') stepLightbox(-1);
    else if (ev.key === 'ArrowRight') stepLightbox(1);
  });

  var quick = null;
  function refreshQa() {
    return api('/v1/qa?limit=100').then(function (data) {
      qa = data;
      // 서버가 읽는 중이거나(프로젝트 추가 직후 등) 분류가 돌고 있으면 30초를
      // 기다리지 않고 3초마다 본다.
      var busyTriage = qa.triage && (qa.triage.running || qa.triage.queued.length);
      if (((qa.poller && qa.poller.running) || busyTriage) && !quick) {
        quick = setTimeout(function () { quick = null; refreshQa().catch(function () {}); }, 3000);
      }
      var visible = visibleQa();
      if (!visible.some(function (i) { return i.postId === qaSelected; })) {
        qaSelected = visible.length ? visible[0].postId : null;
      }
      renderViews();
      if (view === 'qa') renderAll();
    });
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
      renderAll();
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
          renderAll();
        }).catch(function () {});
      }
    }
    if (view === 'jobs') { renderRows(); renderThread(); }
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

  document.getElementById('qa-project').addEventListener('change', function (ev) {
    qaProject = ev.target.value;
    try { localStorage.setItem('morningmate-alert-qa-project', qaProject); } catch (e) {}
    var visible = visibleQa();
    if (!visible.some(function (i) { return i.postId === qaSelected; })) {
      qaSelected = visible.length ? visible[0].postId : null;
    }
    renderAll();
  });
  document.getElementById('qa-add').addEventListener('click', function () {
    openQaPanel(document.getElementById('qa-panel').hidden);
  });
  document.getElementById('qa-pid-add').addEventListener('click', function () {
    addProject(document.getElementById('qa-pid').value.trim(), document.getElementById('qa-pid-add'));
  });
  document.getElementById('qa-pid').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') document.getElementById('qa-pid-add').click();
  });
  try {
    var savedProject = localStorage.getItem('morningmate-alert-qa-project');
    if (savedProject) qaProject = savedProject;
  } catch (e) {}

  document.getElementById('t-triage').addEventListener('click', function () {
    if (!qaSelected) return;
    api('/v1/qa/items/' + encodeURIComponent(qaSelected) + '/triage', { method: 'POST' })
      .then(function () { return refreshQa(); })
      .catch(function () {});
  });

  document.getElementById('t-poll').addEventListener('click', function () {
    if (polling) return;
    polling = true;
    renderThread();
    api('/v1/qa/poll', { method: 'POST' })
      .catch(function () {})
      .then(function () { polling = false; return refreshQa(); })
      .catch(function () { polling = false; renderThread(); });
  });

  document.querySelectorAll('.langswitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      L = b.dataset.lang;
      applyClass();
      document.querySelectorAll('.langswitch button').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.lang === L));
      });
      try { localStorage.setItem('morningmate-alert-lang', L); } catch (e) {}
      renderAll();
    });
  });

  /* 테마. CSS 는 :root[data-theme] 가 있으면 그것을, 없으면 시스템 설정을 따른다 —
     "자동"은 속성을 지우는 것이고 라이트/다크는 속성을 박는 것이다. */
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('.themeswitch button').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.theme === (theme || 'auto')));
    });
  }
  document.querySelectorAll('.themeswitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      applyTheme(b.dataset.theme);
      try { localStorage.setItem('morningmate-alert-theme', b.dataset.theme); } catch (e) {}
    });
  });
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('morningmate-alert-theme'); } catch (e) {}
  applyTheme(savedTheme || 'auto');

  var saved = null;
  try { saved = localStorage.getItem('morningmate-alert-lang'); } catch (e) {}
  var savedView = null;
  try { savedView = localStorage.getItem('morningmate-alert-view'); } catch (e) {}
  if (savedView === 'qa' || savedView === 'jobs') view = savedView;
  applyClass();

  if (saved === 'en' || saved === 'ko') {
    L = saved;
    applyClass();
    document.querySelectorAll('.langswitch button').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.lang === L));
    });
  }

  refresh().then(connect).catch(function () { location.href = '/console/login'; });
  refreshQa().catch(function () {});
  setInterval(function () {
    document.querySelectorAll('.el').forEach(function (el) {
      var job = jobs.filter(function (j) { return j.id === el.dataset.id; })[0];
      if (job && !job.finishedAt) el.textContent = fmt(elapsedOf(job));
    });
  }, 1000);
  setInterval(function () {
    refresh().catch(function () {});
    refreshQa().catch(function () {});
  }, 30000);
})();
