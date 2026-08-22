import { env } from 'cloudflare:workers'
import { createDb } from './db/client'
import { syncBlock } from './sync'

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

  const result = await syncBlock(createDb(env.DB))
  console.log('[cron] nightly sync', JSON.stringify(result))
}
