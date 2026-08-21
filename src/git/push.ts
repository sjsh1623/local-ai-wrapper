import { runOrThrow } from '../util/exec.js';
import { authArgs, gitEnv, remoteUrl } from './credentials.js';
import type { Workspace } from '../workspace/worktree.js';

/**
 * Always a plain push to a fresh branch — never `--force`, and never to the
 * base branch. The worst outcome of a bad run stays "a branch you delete".
 */
export async function pushBranch(ws: Workspace, branch: string, base: string): Promise<void> {
  if (branch === base) {
    throw new Error(`refusing to push onto the base branch (${base})`);
  }
  await runOrThrow(
    'git',
    [...authArgs(), '-C', ws.dir, 'push', '--set-upstream', remoteUrl(ws.repo), `HEAD:${branch}`],
    { env: gitEnv(), timeoutMs: 300_000 },
  );
}
