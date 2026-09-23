import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';
import { t } from '../i18n/index.js';

const cfg = getConfig();

export const CONSOLE_COOKIE = 'bs_key';

function constantTimeIncludes(candidate: string, allowed: string[]): boolean {
  const buf = Buffer.from(candidate);
  let hit = false;
  for (const key of allowed) {
    const other = Buffer.from(key);
    if (other.length === buf.length && timingSafeEqual(buf, other)) hit = true;
  }
  return hit;
}

export function apiKeyOf(req: FastifyRequest): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const query = (req.query as Record<string, unknown> | undefined)?.key;
  if (typeof query === 'string' && query) return query;
  const cookie = (req as any).cookies?.[CONSOLE_COOKIE];
  if (typeof cookie === 'string' && cookie) return cookie;
  return null;
}

/**
 * No keys configured means this is an internal-only deployment that wants no
 * login at all. The SigNoz hook is unaffected — it authenticates with Basic
 * Auth below, so inbound alerts stay guarded either way.
 */
export const authDisabled = cfg.API_KEYS.length === 0;

export function hasValidKey(req: FastifyRequest): boolean {
  if (authDisabled) return true;
  const key = apiKeyOf(req);
  return key !== null && constantTimeIncludes(key, cfg.API_KEYS);
}

/** Guard for every /v1 route except the SigNoz hook, which uses Basic Auth. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (authDisabled) return;
  if (hasValidKey(req)) return;
  await reply.code(401).send({ error: t(cfg.LOCALE, 'error.unauthorized') });
}

/**
 * The SigNoz webhook channel supports only HTTP Basic Auth — no custom headers
 * — so this one endpoint authenticates differently from the rest of the API.
 */
export async function requireSignozBasic(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (
      constantTimeIncludes(user, [cfg.SIGNOZ_WEBHOOK_USER]) &&
      constantTimeIncludes(pass, [cfg.SIGNOZ_WEBHOOK_PASS])
    ) {
      return;
    }
  }
  await reply
    .code(401)
    .header('www-authenticate', 'Basic realm="morningmate-alert"')
    .send({ error: t(cfg.LOCALE, 'error.unauthorized') });
}
