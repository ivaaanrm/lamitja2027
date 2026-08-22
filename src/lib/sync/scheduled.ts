import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { athletes } from '../db/schema'
import { StravaRateLimitError } from '../strava/errors'
import { stravaClientFor } from '../strava/factory'
import { syncRecentActivities } from './activities'
import { enqueue } from './jobs'
import { drainJobs } from './runner'

/**
 * Cron entrypoint. Each schedule declared in wrangler.jsonc lands here; branch on
 * `controller.cron` to pick the job.
 *
 * Test locally without waiting for the clock:
 *   curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"
 */
export const CRON = {
  /** Drain the sync_jobs outbox (webhook follow-ups + backfill pages). */
  DRAIN_OUTBOX: '*/15 * * * *',
  /** Reconcile against Strava, rebuild fitness_daily, re-match plan sessions. */
  NIGHTLY_SYNC: '0 3 * * *',
  /** Adherence rollup + weekly coach brief. */
  WEEKLY_BRIEF: '0 4 * * 1',
} as const

export async function runScheduled(
  controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB)
  const origin = env.PUBLIC_ORIGIN

  switch (controller.cron) {
    case CRON.DRAIN_OUTBOX: {
      const report = await drainJobs(db, origin)
      if (report.claimed > 0) console.log('[cron] drain', JSON.stringify(report))
      return
    }

    case CRON.NIGHTLY_SYNC: {
      await reconcileAll(db, origin)
      return
    }

    case CRON.WEEKLY_BRIEF:
      console.log('[cron] weekly brief — not implemented yet (phase 5)')
      return

    default:
      // An unrecognised schedule means wrangler.jsonc and this switch drifted.
      console.warn(`[cron] no handler for schedule: ${controller.cron}`)
  }
}

/**
 * Catches anything the webhook missed — dropped deliveries, activities edited while the
 * subscription was down, or a first sync that never got a webhook at all.
 */
async function reconcileAll(db: ReturnType<typeof createDb>, origin: string): Promise<void> {
  const connected = await db.query.athletes.findMany({
    where: eq(athletes.allowlisted, true),
  })

  for (const athlete of connected) {
    try {
      const client = await stravaClientFor(db, athlete.id, origin)
      const result = await syncRecentActivities(db, client, athlete.id)
      console.log(`[cron] reconciled athlete ${athlete.id}`, JSON.stringify(result))
    } catch (error) {
      if (error instanceof StravaRateLimitError) {
        // Park the work in the outbox rather than losing the tick entirely.
        await enqueue(db, {
          athleteId: athlete.id,
          kind: 'backfill.page',
          runAt: error.retryAt,
        })
        console.warn(`[cron] rate limited for athlete ${athlete.id}, deferred`)
        continue
      }
      console.error(`[cron] reconcile failed for athlete ${athlete.id}`, error)
    }
  }
}
