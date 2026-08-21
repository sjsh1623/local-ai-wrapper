/** Docker HEALTHCHECK entry point: exits non-zero when /healthz is not OK. */
const port = process.env.PORT ?? '8080';

try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    process.stderr.write(`healthz returned ${res.status}\n`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`healthz unreachable: ${String(err)}\n`);
  process.exit(1);
}
