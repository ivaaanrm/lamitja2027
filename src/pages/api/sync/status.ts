import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { getAthleteId, json, jsonError } from '@/lib/auth/session'
import { createDb } from '@/lib/db/client'
import { athletes, syncState } from '@/lib/db/schema'
import { activityCount, latestActivity } from '@/lib/sync/activities'
import { jobCounts } from '@/lib/sync/jobs'
import { readSnapshot } from '@/lib/strava/ratelimit'

export const prerender = false

/** Sync health for the settings screen: what is connected, how far the backfill got. */
export const GET: APIRoute = async (context) => {
  const athleteId = await getAthleteId(context)
  if (athleteId === null) return jsonError('Not signed in', 401)

  const db = createDb(env.DB)
  const now = Date.now()

  const [athlete, state, count, latest, jobs, budget] = await Promise.all([
    db.query.athletes.findFirst({ where: eq(athletes.id, athleteId) }),
    db.query.syncState.findFirst({ where: eq(syncState.athleteId, athleteId) }),
    activityCount(db, athleteId),
    latestActivity(db, athleteId),
    jobCounts(db),
    readSnapshot(env.CACHE, now),
  ])

  return json({
    athlete: athlete && {
      id: athlete.id,
      name: [athlete.firstname, athlete.lastname].filter(Boolean).join(' '),
      profileUrl: athlete.profileUrl,
    },
    activities: {
      count,
      latest: latest && { id: latest.id, name: latest.name, startAt: latest.startAt },
    },
    backfill: {
      complete: state?.backfillComplete ?? false,
      oldestFetchedAt: state?.backfillBefore ?? null,
      lastFullSyncAt: state?.lastFullSyncAt ?? null,
    },
    jobs: Object.fromEntries(jobs.map((row) => [row.status, row.count])),
    rateLimit: {
      shortUsage: `${budget.shortUsage}/${budget.shortLimit}`,
      dailyUsage: `${budget.dailyUsage}/${budget.dailyLimit}`,
    },
  })
}
