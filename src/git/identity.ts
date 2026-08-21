import { runOrThrow } from '../util/exec.js';
import { getConfig } from '../config.js';
import { gitEnv } from './credentials.js';

const cfg = getConfig();

/**
 * Identity is pinned in the worktree's own config rather than relied on from a
 * global setting — a global has been observed to be bypassed, and a commit
 * landing under the wrong address cannot be fixed after it is pushed.
 */
export async function pinIdentity(cwd: string): Promise<void> {
  await runOrThrow('git', ['config', '--local', 'user.name', cfg.GIT_AUTHOR_NAME], {
    cwd,
    env: gitEnv(),
  });
  await runOrThrow('git', ['config', '--local', 'user.email', cfg.GIT_AUTHOR_EMAIL], {
    cwd,
    env: gitEnv(),
  });
}

export async function verifyIdentity(cwd: string): Promise<string> {
  const { stdout } = await runOrThrow('git', ['config', '--local', 'user.email'], {
    cwd,
    env: gitEnv(),
  });
  const email = stdout.trim();
  if (email !== cfg.GIT_AUTHOR_EMAIL) {
    throw new Error(`commit identity is ${email}, expected ${cfg.GIT_AUTHOR_EMAIL}`);
  }
  return email;
}
