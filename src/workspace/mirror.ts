import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { runOrThrow } from '../util/exec.js';
import { authArgs, gitEnv, remoteUrl } from '../git/credentials.js';

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
 * One bare mirror per repository, refreshed in place. The first job on a repo
 * pays for a clone; every job after it pays for a fetch.
 */
export async function ensureMirror(repo: string): Promise<string> {
  const path = mirrorPath(repo);
  await mkdir(cfg.cacheDir, { recursive: true });

  if (await exists(join(path, 'HEAD'))) {
    await runOrThrow('git', [...authArgs(), '-C', path, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], {
      env: gitEnv(),
      timeoutMs: 300_000,
    });
    return path;
  }

  await runOrThrow('git', [...authArgs(), 'clone', '--mirror', remoteUrl(repo), path], {
    env: gitEnv(),
    timeoutMs: 600_000,
  });
  return path;
}
