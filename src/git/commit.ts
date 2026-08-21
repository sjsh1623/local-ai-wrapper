import { run, runOrThrow } from '../util/exec.js';
import { gitEnv } from './credentials.js';
import { pinIdentity, verifyIdentity } from './identity.js';
import type { Workspace } from '../workspace/worktree.js';

export interface CommitResult {
  committed: boolean;
  files: number;
  author: string;
  sha: string | null;
}

export async function commitAll(
  ws: Workspace,
  message: string,
): Promise<CommitResult> {
  await pinIdentity(ws.dir);
  const author = await verifyIdentity(ws.dir);

  await runOrThrow('git', ['-C', ws.dir, 'add', '-A'], { env: gitEnv() });

  const staged = await run('git', ['-C', ws.dir, 'diff', '--cached', '--name-only'], {
    env: gitEnv(),
  });
  const files = staged.stdout.split('\n').filter((l) => l.trim()).length;
  if (files === 0) return { committed: false, files: 0, author, sha: null };

  await runOrThrow('git', ['-C', ws.dir, 'commit', '-m', message], {
    env: gitEnv(),
    timeoutMs: 60_000,
  });

  const { stdout } = await runOrThrow('git', ['-C', ws.dir, 'rev-parse', 'HEAD'], {
    env: gitEnv(),
  });
  return { committed: true, files, author, sha: stdout.trim() };
}
