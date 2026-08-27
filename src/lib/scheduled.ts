import { env } from 'cloudflare:workers'
import { listAccounts } from './accounts'
import { createDb } from './db/client'
import { syncUser } from './sync'

/**
 * Cron entrypoint. The webhook handles the common case; this is the safety net for
 * deliveries Strava dropped.
 *
 * Test locally: curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"
 */
export async function runScheduled(controller: ScheduledController): Promise<void> {
  if (controller.cron !== '0 3 * * *') {
    console.warn(`[cron] no handler for schedule: ${controller.cron}`)
    return
  }

  const db = createDb(env.DB)
  const accounts = await listAccounts(db)

  // One athlete at a time, each in its own try: a refresh token that died — revoked in
  // Strava, or rotated behind our back — is one athlete's problem, and throwing out of the
  // loop would silently skip everyone after them until they noticed. Sequential rather than
  // in parallel because the log is the only place this run is ever seen, and a handful of
  // athletes at one full-block fetch each is nowhere near a rate limit either way.
  for (const account of accounts) {
    try {
      const result = await syncUser(db, account.userId)
      const outcome = result ? `${result.fetched} activities` : 'no block yet'
      console.log(`[cron] ${account.userId}: ${outcome}`)
    } catch (error) {
      console.error(`[cron] ${account.userId}: sync failed`, error)
    }
  }
}
