/**
 * Secrets must never reach a log line, an SSE frame, or a Flow comment — that
 * last one is read by people, which is exactly where a leaked token does the
 * most damage. Everything the bus and the logger emit passes through here.
 */
const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,          // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,           // Anthropic keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[A-Za-z0-9_-]{0,10}(?:secret|token|password|api[_-]?key)["'\s:=]+["']?([^\s"',}]{8,})/gi,
];

const MASK = '«redacted»';

export function redactString(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, captured?: string) => {
      if (typeof captured === 'string' && captured.length > 0) {
        return match.replace(captured, MASK);
      }
      return MASK;
    });
  }
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
