import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { processMergedPR, processManualResolve } from './prProcessor';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { Semaphore } from '../utils/async';
import { ManualResolveEvent, MergedPREvent, QueueJobData } from '../types';

const QUEUE_NAME = 'conflict-resolution';

let queue: Queue | null = null;
let worker: Worker | null = null;
let connection: IORedis | null = null;

export function isQueueEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
    });
    connection.on('error', (err) => logger.error('Redis connection error:', err));
  }
  return connection;
}

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return queue;
}

async function dispatch(data: QueueJobData): Promise<void> {
  if (data.type === 'manual') {
    await processManualResolve(data as ManualResolveEvent);
  } else {
    await processMergedPR(data as MergedPREvent);
  }
}

export function startWorker(): void {
  if (!isQueueEnabled()) return;

  worker = new Worker<QueueJobData>(
    QUEUE_NAME,
    async (job: Job<QueueJobData>) => {
      logger.info(`Processing job ${job.id} for PR #${job.data.prNumber}`);
      await dispatch(job.data);
    },
    {
      connection: getConnection(),
      concurrency: config.settings.queueConcurrency,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed (PR #${job.data.prNumber})`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed (PR #${job?.data.prNumber}):`, err);
  });

  logger.info(`BullMQ worker started (concurrency ${config.settings.queueConcurrency})`);
}

// ─── In-process fallback ───────────────────────────────────────────────────────
// Without Redis we still need two production properties: bounded concurrency
// (a burst of merges must not fork unbounded git clones + API calls) and
// dedup of GitHub's at-least-once webhook redeliveries.

const inProcessSemaphore = new Semaphore(config.settings.inProcessConcurrency);
const recentJobs = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(jobId: string): boolean {
  const now = Date.now();
  for (const [key, ts] of recentJobs) {
    if (now - ts > DEDUP_TTL_MS) recentJobs.delete(key);
  }
  if (recentJobs.has(jobId)) return true;
  recentJobs.set(jobId, now);
  return false;
}

function runInProcess(jobId: string, data: QueueJobData): void {
  inProcessSemaphore
    .run(() => dispatch(data))
    .catch((err) => {
      logger.error(`In-process job ${jobId} failed (PR #${data.prNumber}):`, err);
    });
}

// ─── Enqueue APIs ──────────────────────────────────────────────────────────────

export async function enqueueConflictResolution(event: MergedPREvent): Promise<void> {
  const jobId = `pr-${event.repoOwner}-${event.repoName}-${event.prNumber}-${event.mergedAt}`;
  const data: QueueJobData = { type: 'merged', ...event };

  if (!isQueueEnabled()) {
    if (isDuplicate(jobId)) {
      logger.info(`Duplicate webhook delivery ${jobId}, skipping`);
      return;
    }
    runInProcess(jobId, data);
    return;
  }

  await getQueue().add(QUEUE_NAME, data, { jobId, deduplication: { id: jobId } });
  logger.info(`Enqueued conflict resolution job ${jobId}`);
}

export async function enqueueManualResolve(event: ManualResolveEvent): Promise<void> {
  const jobId = `manual-${event.repoOwner}-${event.repoName}-${event.prNumber}-${event.requestedAt}`;
  const data: QueueJobData = { type: 'manual', ...event };

  if (!isQueueEnabled()) {
    // GitHub redelivers issue_comment events at least once — dedup like the
    // merged path so a duplicate delivery doesn't run two resolutions.
    if (isDuplicate(jobId)) {
      logger.info(`Duplicate manual-resolve delivery ${jobId}, skipping`);
      return;
    }
    runInProcess(jobId, data);
    return;
  }

  await getQueue().add(QUEUE_NAME, data, { jobId, deduplication: { id: jobId } });
  logger.info(`Enqueued manual resolve job ${jobId}`);
}

export async function getQueueStats() {
  if (!isQueueEnabled()) return null;
  const q = getQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getCompletedCount(),
    q.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

export async function closeQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  await connection?.quit();
}
