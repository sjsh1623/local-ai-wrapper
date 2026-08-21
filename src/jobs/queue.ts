import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { emit } from '../notify/bus.js';
import * as store from './store.js';
import { runJob } from './lifecycle.js';
import type { Job } from '../types.js';

const cfg = getConfig();

const pending: string[] = [];
const running = new Map<string, AbortController>();
/** Repositories with a job in flight — a second job on the same repo waits. */
const busyRepos = new Set<string>();

let draining = false;

export function enqueue(job: Job): void {
  pending.push(job.id);
  void pump();
}

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function runningCount(): number {
  return running.size;
}

export function pendingCount(): number {
  return pending.length;
}

export function cancel(jobId: string): boolean {
  const controller = running.get(jobId);
  if (controller) {
    controller.abort();
    return true;
  }
  const index = pending.indexOf(jobId);
  if (index >= 0) {
    pending.splice(index, 1);
    store.updateJob(jobId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      error: 'cancelled before it started',
    });
    const job = store.getJob(jobId);
    if (job) void emit(job, { stage: 'queued', status: 'failed', key: 'job.cancelled' });
    return true;
  }
  return false;
}

/**
 * Start whatever can start. Two rules gate it: the global concurrency limit
 * (1 by default, because parallel claude processes contend on one credential
 * file) and one job at a time per repository.
 */
async function pump(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0 && running.size < cfg.JOB_CONCURRENCY) {
      const index = pending.findIndex((id) => {
        const job = store.getJob(id);
        return job ? !busyRepos.has(job.repo) : false;
      });
      if (index < 0) break; // everything left is blocked by its own repository

      const jobId = pending.splice(index, 1)[0]!;
      const job = store.getJob(jobId);
      if (!job || job.status !== 'queued') continue;

      const controller = new AbortController();
      running.set(jobId, controller);
      busyRepos.add(job.repo);

      void runJob(job, controller.signal)
        .catch((err) => {
          logger.error({ err: String(err), jobId }, 'job crashed outside the lifecycle');
          store.updateJob(jobId, {
            status: 'failed',
            error: String(err),
            finishedAt: new Date().toISOString(),
          });
        })
        .finally(() => {
          running.delete(jobId);
          busyRepos.delete(job.repo);
          void pump();
        });
    }
  } finally {
    draining = false;
  }
}

/** Whether a newly accepted job will start now or wait behind another. */
export function willWait(repo: string): boolean {
  return busyRepos.has(repo) || running.size >= cfg.JOB_CONCURRENCY;
}

/** Requeue anything left `queued` by a restart. */
export function resume(): number {
  const jobs = store.queuedJobs();
  for (const job of jobs) pending.push(job.id);
  if (jobs.length) void pump();
  return jobs.length;
}

export async function shutdown(): Promise<void> {
  for (const controller of running.values()) controller.abort();
}
