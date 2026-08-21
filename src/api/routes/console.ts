import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { CONSOLE_COOKIE, hasValidKey } from '../auth.js';

const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../console');

const LOGIN_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Branchsmith</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#E6EBE9;color:#0E1D1C;
       font-family:Archivo,-apple-system,"Helvetica Neue",sans-serif}
  @media (prefers-color-scheme:dark){body{background:#08110F;color:#E1EDE9}form{background:#0F1B1A;border-color:#213734}}
  form{background:#F6F9F7;border:1px solid #C3D0CC;padding:26px 28px;display:flex;
       flex-direction:column;gap:12px;min-width:300px}
  h1{margin:0;font-size:1.1rem;letter-spacing:-.02em}
  p{margin:0;font-size:.85rem;opacity:.7}
  input{padding:9px 11px;border:1px solid #C3D0CC;background:transparent;color:inherit;
        font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
  button{padding:9px 11px;border:0;background:#0D6870;color:#F6F9F7;cursor:pointer;
         font-family:ui-monospace,Menlo,monospace;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
</style></head>
<body>
  <form method="POST" action="/console/session">
    <h1>Branchsmith</h1>
    <p>API 키를 입력하세요 · Enter an API key</p>
    <input name="key" type="password" autocomplete="current-password" autofocus required>
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

  app.get('/console/login', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(LOGIN_PAGE),
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
