import { createHmac } from 'node:crypto';
import { getConfig } from '../../config.js';
import type { JobEvent } from '../../types.js';

const cfg = getConfig();

export function webhookEnabled(url?: string | null): boolean {
  return Boolean(url || cfg.WEBHOOK_URL);
}

export async function send(event: JobEvent, url?: string | null): Promise<void> {
  const target = url || cfg.WEBHOOK_URL;
  if (!target) return;

  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.WEBHOOK_SECRET) {
    const sig = createHmac('sha256', cfg.WEBHOOK_SECRET).update(body).digest('hex');
    headers['x-morningmate-alert-signature'] = `sha256=${sig}`;
  }

  const res = await fetch(target, { method: 'POST', headers, body });
  if (!res.ok) {
    throw new Error(`webhook ${res.status} ${res.statusText}`);
  }
}
