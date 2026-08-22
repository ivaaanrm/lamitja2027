import type { Database } from '../db/client'
import type { SyncJob } from '../db/schema'
import { StravaRateLimitError } from '../strava/errors'
import { stravaClientFor } from '../strava/factory'
import { mapLap } from '../strava/mapper'
import { backfillPage, deleteActivity, upsertActivities, upsertLaps } from './activities'
import { claimDueJobs, deferAll, enqueue, markDone, markFailed, pruneCompleted } from './jobs'
import { mapActivity } from '../strava/mapper'

/** Keep a drain well inside the cron's wall-clock and the read-rate budget. */
const JOBS_PER_RUN = 10
const DONE_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface DrainReport {
  claimed: number
  succeeded: number
  failed: number
  rateLimited: boolean
}

/**
 * Drains the outbox. Runs from the quarter-hourly cron and immediately after a webhook
 * via `waitUntil`, so a new activity usually lands within seconds but never depends on
 * that request surviving.
 */
export async function drainJobs(
  db: Database,
  origin: string,
  now: number = Date.now(),
): Promise<DrainReport> {
  const jobs = await claimDueJobs(db, now, JOBS_PER_RUN)
  const report: DrainReport = { claimed: jobs.length, succeeded: 0, failed: 0, rateLimited: false }

  for (const job of jobs) {
    try {
      await runJob(db, job, origin)
      await markDone(db, job.id)
      report.succeeded += 1
    } catch (error) {
      report.failed += 1

      if (error instanceof StravaRateLimitError) {
        // No point trying the rest of the queue against a closed window.
        await markFailed(db, job, error, error.retryAt)
        await deferAll(db, error.retryAt)
        report.rateLimited = true
        break
      }

      await markFailed(db, job, error)
    }
  }

  await pruneCompleted(db, DONE_JOB_TTL_MS)
  return report
}

async function runJob(db: Database, job: SyncJob, origin: string): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>
  const now = Date.now()

  switch (job.kind) {
    case 'activity.upsert': {
      const activityId = Number(payload.activityId)
      const client = await stravaClientFor(db, job.athleteId, origin)
      const activity = await client.getActivity(activityId)

      await upsertActivities(db, [mapActivity(activity, job.athleteId, now)])

      // Laps are a second call; queue rather than spend the budget inline.
      await enqueue(db, {
        athleteId: job.athleteId,
        kind: 'laps.fetch',
        payload: { activityId },
      })
      return
    }

    case 'activity.delete': {
      await deleteActivity(db, Number(payload.activityId))
      return
    }

    case 'laps.fetch': {
      const activityId = Number(payload.activityId)
      const client = await stravaClientFor(db, job.athleteId, origin)
      const fetched = await client.getActivityLaps(activityId)

      await upsertLaps(
        db,
        activityId,
        fetched.map((lap) => mapLap(lap, activityId, now)),
      )
      return
    }

    case 'backfill.page': {
      const client = await stravaClientFor(db, job.athleteId, origin)
      const result = await backfillPage(db, client, job.athleteId, now)

      // Re-enqueue until history runs out; one page per tick keeps us inside the budget.
      if (!result.complete) {
        await enqueue(db, { athleteId: job.athleteId, kind: 'backfill.page' })
      }
      return
    }

    default: {
      const exhaustive: never = job.kind
      throw new Error(`Unknown job kind: ${String(exhaustive)}`)
    }
  }
}
