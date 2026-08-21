import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { runOrThrow } from '../util/exec.js';
import { authArgs, gitEnv, remoteUrl } from '../git/credentials.js';
import { logger } from '../logger.js';

const cfg = getConfig();

function mirrorPath(repo: string): string {
  return join(cfg.cacheDir, `${repo.replace('/', '__')}.git`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A repository placed under REPOS_DIR by hand wins over GitHub.
 *
 * Both `<dir>/<name>` and `<dir>/<owner>/<name>` are accepted — either is what
 * you get from cloning a pile of repositories side by side. A bare clone is
 * recognised too, hence the two probes.
 *
 * Only committed history crosses over. Uncommitted edits in that checkout are
 * invisible here, which is the honest behaviour: the agent branches from a
 * commit, and there is no commit for work you have not made yet.
 */
async function localSource(repo: string): Promise<string | null> {
  const [owner = '', name = ''] = repo.split('/');
  if (!owner || !name) return null;
  for (const dir of [join(cfg.reposDir, name), join(cfg.reposDir, owner, name)]) {
    if ((await exists(join(dir, '.git'))) || (await exists(join(dir, 'HEAD')))) return dir;
  }
  return null;
}

/**
 * One bare mirror per repository, refreshed in place. The first job on a repo
 * pays for a clone; every job after it pays for a fetch.
 *
 * The mirror is only ever a read cache — pushing goes straight to GitHub from
 * the worktree (see git/push.ts), so pointing this at a local path changes where
 * code is read from and nothing about where pull requests land.
 */
export async function ensureMirror(repo: string): Promise<string> {
  const path = mirrorPath(repo);
  const local = await localSource(repo);
  const source = local ?? remoteUrl(repo);
  // A local path needs no credential helper, and handing it one would be a lie.
  const auth = local ? [] : authArgs();

  await mkdir(cfg.cacheDir, { recursive: true });
  logger.info({ repo, source, local: local !== null }, 'resolving repository source');

  if (await exists(join(path, 'HEAD'))) {
    // Fetch by explicit source rather than by remote name: the source can change
    // between runs — a repository dropped into REPOS_DIR after the first clone —
    // and a stale `origin` would quietly keep pulling from the old one.
    await runOrThrow('git', [...auth, '-C', path, 'fetch', '--prune', source, '+refs/heads/*:refs/heads/*'], {
      env: gitEnv(),
      timeoutMs: 300_000,
    });
    return path;
  }

  await runOrThrow('git', [...auth, 'clone', '--mirror', source, path], {
    env: gitEnv(),
    timeoutMs: 600_000,
  });
  return path;
}
