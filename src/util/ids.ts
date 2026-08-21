import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U

/** Short, sortable-ish, copy-pasteable job id: job_01K8ZQ4M7 */
export function newJobId(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `job_${Date.now().toString(32).toUpperCase().slice(-4)}${out}`;
}

/** Lowercase, hyphenated, git-safe branch component. */
export function slugify(input: string, max = 48): string {
  const slug = input
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'change';
}
