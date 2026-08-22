import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { gte } from 'drizzle-orm'
import { json } from '@/lib/api'
import { BLOCK_START } from '@/lib/block'
import { createDb } from '@/lib/db/client'
import { activities, planSessions, planWeeks } from '@/lib/db/schema'
import { getState, KEY } from '@/lib/state'

export const prerender = false

/**
 * Everything the UI needs, in one request. The whole block is ~150 activities, 22 weeks
 * and a few hundred planned sessions — a few tens of KB — so splitting it across
 * endpoints would buy nothing but round trips. Matching plan to actuals and every metric
 * derived from them happens on the client, from exactly this payload.
 */
export const GET: APIRoute = async () => {
  const db = createDb(env.DB)

  const [acts, weeks, sessions, athleteRaw, lastSync] = await Promise.all([
    db.select().from(activities).where(gte(activities.startedOn, BLOCK_START)),
    db.select().from(planWeeks).orderBy(planWeeks.weekIndex),
    db.select().from(planSessions).orderBy(planSessions.scheduledOn, planSessions.dayOrder),
    getState(db, KEY.STRAVA_ATHLETE),
    getState(db, KEY.LAST_SYNC_AT),
  ])

  return json({
    athlete: athleteRaw ? JSON.parse(athleteRaw) : null,
    stravaConnected: athleteRaw !== null,
    lastSyncAt: lastSync ? Number(lastSync) : null,
    activities: acts,
    weeks,
    sessions,
  })
}
