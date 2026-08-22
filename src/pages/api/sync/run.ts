import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { getAthleteId, json, jsonError } from '@/lib/auth/session'
import { createDb } from '@/lib/db/client'
import { getSyncState } from '@/lib/sync/activities'
import { enqueue } from '@/lib/sync/jobs'
import { drainJobs } from '@/lib/sync/runner'

export const prerender = false

/**
 * Manual "sync now". The cron is the safety net, but waiting up to fifteen minutes to see
 * whether a connection worked is not a reasonable first experience — and it is the same
 * button you want after a run that Strava's webhook missed.
 */
export const POST: APIRoute = async (context) => {
  const athleteId = await getAthleteId(context)
  if (athleteId === null) return jsonError('Not signed in', 401)

  const db = createDb(env.DB)

  // Make sure there is something to do: resume an unfinished backfill.
  const state = await getSyncState(db, athleteId)
  if (!state.backfillComplete) {
    await enqueue(db, { athleteId, kind: 'backfill.page' })
  }

  const report = await drainJobs(db, context.url.origin)
  return json(report)
}
