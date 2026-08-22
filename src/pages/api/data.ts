import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { gte } from 'drizzle-orm'
import { json } from '@/lib/auth'
import { BLOCK_START } from '@/lib/block'
import { createDb } from '@/lib/db/client'
import { activities, planSessions } from '@/lib/db/schema'
import { getState, KEY } from '@/lib/state'

export const prerender = false

/**
 * Everything the UI needs, in one request. The whole block is ~150 activities and ~130
 * planned sessions — a few tens of KB — so splitting it across endpoints would buy
 * nothing but round trips.
 */
export const GET: APIRoute = async () => {
  const db = createDb(env.DB)

  const [acts, plan, athleteRaw, lastSync] = await Promise.all([
    db.select().from(activities).where(gte(activities.startedOn, BLOCK_START)),
    db.select().from(planSessions).orderBy(planSessions.scheduledOn),
    getState(db, KEY.STRAVA_ATHLETE),
    getState(db, KEY.LAST_SYNC_AT),
  ])

  return json({
    athlete: athleteRaw ? JSON.parse(athleteRaw) : null,
    stravaConnected: athleteRaw !== null,
    lastSyncAt: lastSync ? Number(lastSync) : null,
    activities: acts,
    plan,
  })
}
