import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { authDisabled, CONSOLE_COOKIE, hasValidKey } from '../auth.js';

const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../console');

const LOGIN_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>알럿 자동조사 콘솔</title>
<style>
  /* 콘솔과 같은 Apple 시스템 팔레트. 시트 하나만 있는 화면이라 토큰도 그만큼만. */
  :root{
    color-scheme:light dark;
    --sf:-apple-system,BlinkMacSystemFont,"SF Pro Text","Pretendard Variable",Pretendard,
        "Apple SD Gothic Neo","Malgun Gothic","맑은 고딕","Noto Sans KR",sans-serif;
    --bg:#F2F2F7; --surface:#FFFFFF;
    --fill:rgba(120,120,128,.12);
    --label:#1D1D1F; --label-2:rgba(60,60,67,.62);
    --blue:#007AFF; --focus:rgba(0,122,255,.35);
    --shadow:0 0 0 .5px rgba(0,0,0,.05),0 10px 34px rgba(0,0,0,.12);
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#000000;--surface:#1C1C1E;--fill:rgba(120,120,128,.24);
          --label:#F5F5F7;--label-2:rgba(235,235,245,.6);
          --blue:#0A84FF;--focus:rgba(10,132,255,.45);
          --shadow:0 0 0 .5px rgba(0,0,0,.6),0 10px 34px rgba(0,0,0,.5)}
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
       background:var(--bg);color:var(--label);font-family:var(--sf);
       font-size:14px;letter-spacing:-.005em}
  form{background:var(--surface);border-radius:20px;box-shadow:var(--shadow);
       padding:30px 28px 26px;display:flex;flex-direction:column;gap:14px;width:min(340px,100%)}
  .glyph{width:52px;height:52px;border-radius:12px;display:grid;place-items:center;
         background:linear-gradient(180deg,#3F9BFF,#007AFF);color:#fff;
         box-shadow:0 2px 6px rgba(0,0,0,.2);margin-bottom:4px}
  h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.022em}
  p{margin:0 0 4px;font-size:13.5px;color:var(--label-2);line-height:1.5}
  input{padding:11px 13px;border:0;border-radius:10px;background:var(--fill);color:inherit;
        font-family:inherit;font-size:15px;width:100%}
  input::placeholder{color:var(--label-2)}
  button{padding:11px 13px;border:0;border-radius:10px;background:var(--blue);color:#fff;
         cursor:pointer;font-family:inherit;font-size:15px;font-weight:600;letter-spacing:-.01em;
         transition:filter .16s cubic-bezier(.32,.72,0,1)}
  button:hover{filter:brightness(1.06)}
  button:active{transform:scale(.98)}
  :focus-visible{outline:none;box-shadow:0 0 0 3.5px var(--focus)}
</style></head>
<body>
  <form method="POST" action="/console/session">
    <span class="glyph" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2 4 14h7l-1 8 9-12h-7z"/>
      </svg>
    </span>
    <h1>알럿 자동조사 콘솔</h1>
    <p>API 키를 입력하면 열립니다 · Enter an API key to continue</p>
    <input name="key" type="password" autocomplete="current-password" placeholder="API key" autofocus required>
    <button type="submit">열기 · Open</button>
  </form>
</body></html>
`;

export default async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    if (!hasValidKey(req)) return reply.redirect('/console/login');
    // A key passed as ?key= is exchanged for a cookie so it stops travelling
    // in URLs — and so EventSource, which cannot set headers, can authenticate.
    const queryKey = (req.query as Record<string, unknown>)?.key;
    if (typeof queryKey === 'string' && queryKey) {
      setSession(reply, queryKey);
      return reply.redirect('/');
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(await readFile(join(assets, 'index.html'), 'utf8'));
  });

  // With no keys configured there is nothing to type, so never show the form —
  // a bookmarked /console/login would otherwise be a dead end.
  app.get('/console/login', async (_req, reply) =>
    authDisabled
      ? reply.redirect('/')
      : reply.type('text/html; charset=utf-8').send(LOGIN_PAGE),
  );

  app.post('/console/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body.key === 'string' ? body.key : '';
    setSession(reply, key);
    return reply.redirect('/');
  });

  app.get('/console/console.js', async (_req, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .send(await readFile(join(assets, 'console.js'), 'utf8')),
  );
}

function setSession(reply: any, key: string): void {
  reply.setCookie(CONSOLE_COOKIE, key, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 12,
  });
}
