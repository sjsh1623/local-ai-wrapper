import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { run, runOrThrow } from '../util/exec.js';
import { gitEnv } from '../git/credentials.js';
import { ensureMirror } from './mirror.js';
import { logger } from '../logger.js';

const cfg = getConfig();

export interface Workspace {
  dir: string;
  mirror: string;
  repo: string;
}

/**
 * Carve an isolated checkout for one job. The agent's working directory is
 * pinned here, so it cannot reach another repository or a host path.
 */
export async function createWorkspace(
  jobId: string,
  repo: string,
  base: string,
): Promise<Workspace> {
  const mirror = await ensureMirror(repo);
  const dir = join(cfg.workspaceDir, jobId);
  await mkdir(cfg.workspaceDir, { recursive: true });
  await rm(dir, { recursive: true, force: true });

  await runOrThrow('git', ['-C', mirror, 'worktree', 'add', '--detach', dir, base], {
    env: gitEnv(),
    timeoutMs: 300_000,
  });

  return { dir, mirror, repo };
}

export async function createBranch(ws: Workspace, branch: string): Promise<void> {
  await runOrThrow('git', ['-C', ws.dir, 'checkout', '-B', branch], {
    env: gitEnv(),
    timeoutMs: 60_000,
  });
}

export async function changedFiles(ws: Workspace): Promise<string[]> {
  const { stdout } = await runOrThrow('git', ['-C', ws.dir, 'status', '--porcelain'], {
    env: gitEnv(),
  });
  return stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export async function diffStat(ws: Workspace): Promise<string> {
  const { stdout } = await run('git', ['-C', ws.dir, 'diff', '--stat', 'HEAD'], { env: gitEnv() });
  return stdout.trim();
}

export async function destroyWorkspace(ws: Workspace, keep: boolean): Promise<void> {
  if (keep) {
    logger.info({ dir: ws.dir }, 'KEEP_WORKSPACE is set, leaving the worktree in place');
    return;
  }
  // `worktree remove` first so the mirror's administrative files stay clean;
  // the rm is the belt-and-braces for a worktree git already lost track of.
  await run('git', ['-C', ws.mirror, 'worktree', 'remove', '--force', ws.dir], { env: gitEnv() });
  await rm(ws.dir, { recursive: true, force: true });
  await run('git', ['-C', ws.mirror, 'worktree', 'prune'], { env: gitEnv() });
}
