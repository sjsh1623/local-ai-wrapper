import { t, stageLabel } from '../i18n/index.js';
import { STAGES, stageIndex } from '../types.js';
import type { EmitInput, Locale, Stage } from '../types.js';

/**
 * Turns a stage emission into the one sentence that ships everywhere — Flow
 * comment, webhook payload, SSE frame, log line. Callers never build text.
 */
export function renderText(locale: Locale, input: EmitInput): string {
  const n = stageIndex(input.stage);
  const detail = t(locale, input.key, input.params ?? {});
  const label = stageLabel(locale, input.stage);
  // A key that resolves to itself means the catalog has no entry; drop the
  // dangling separator rather than print "[5/9] Editing — job.foo".
  if (detail === input.key) return `[${n}/9] ${label}`;
  return `[${n}/9] ${label} — ${detail}`;
}

export function progressOf(stage: Stage, status: string): number {
  const n = stageIndex(stage);
  const base = (n - 1) / STAGES.length;
  const span = 1 / STAGES.length;
  if (status === 'done') return Math.min(1, base + span);
  if (status === 'started') return base;
  return base + span / 2;
}
