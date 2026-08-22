import { and, eq, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { syncJobs, type JobKind, type SyncJob } from '../db/schema'
import { randomToken } from '../crypto'

/** Give up after this many attempts and leave the row as `failed` for inspection. */
export const MAX_ATTEMPTS = 6

/** Exponential backoff with a ceiling, so a persistent failure retries hourly, not forever-faster. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** attempts * 30 * 1000)
}

export async function enqueue(
  db: Database,
  job: { athleteId: number; kind: JobKind; payload?: unknown; runAt?: number },
): Promise<string> {
  const id = randomToken(12)
  const now = Date.now()

  await db.insert(syncJobs).values({
    id,
    athleteId: job.athleteId,
    kind: job.kind,
    payload: job.payload ?? {},
    nextAttemptAt: job.runAt ?? now,
    createdAt: now,
    updatedAt: now,
  })

  return id
}

/** Jobs whose backoff has elapsed, oldest first. */
export async function claimDueJobs(db: Database, now: number, limit = 20): Promise<SyncJob[]> {
  return db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.status, 'pending'), lte(syncJobs.nextAttemptAt, now)))
    .orderBy(syncJobs.nextAttemptAt)
    .limit(limit)
}

export async function markDone(db: Database, id: string): Promise<void> {
  await db
    .update(syncJobs)
    .set({ status: 'done', updatedAt: Date.now() })
    .where(eq(syncJobs.id, id))
}

/**
 * Records a failure and schedules the retry. `retryAt` lets a rate-limit error park the
 * job until the window actually reopens instead of burning attempts against a closed door.
 */
export async function markFailed(
  db: Database,
  job: SyncJob,
  error: unknown,
  retryAt?: number,
): Promise<void> {
  const attempts = job.attempts + 1
  const exhausted = attempts >= MAX_ATTEMPTS
  const now = Date.now()

  await db
    .update(syncJobs)
    .set({
      attempts,
      status: exhausted ? 'failed' : 'pending',
      lastError: error instanceof Error ? error.message : String(error),
      nextAttemptAt: retryAt ?? now + backoffMs(attempts),
      updatedAt: now,
    })
    .where(eq(syncJobs.id, job.id))
}

/** Drops completed jobs so the outbox does not grow without bound. */
export async function pruneCompleted(db: Database, olderThanMs: number): Promise<void> {
  await db
    .delete(syncJobs)
    .where(and(eq(syncJobs.status, 'done'), lte(syncJobs.updatedAt, Date.now() - olderThanMs)))
}

/** Rate-limit errors park every pending job, not just the one that hit the wall. */
export async function deferAll(db: Database, retryAt: number): Promise<void> {
  await db
    .update(syncJobs)
    .set({ nextAttemptAt: retryAt, updatedAt: Date.now() })
    .where(and(eq(syncJobs.status, 'pending'), lte(syncJobs.nextAttemptAt, retryAt)))
}

export const jobCounts = (db: Database) =>
  db
    .select({ status: syncJobs.status, count: sql<number>`count(*)` })
    .from(syncJobs)
    .groupBy(syncJobs.status)
