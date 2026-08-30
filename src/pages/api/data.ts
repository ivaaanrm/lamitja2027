import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { getAccount } from '@/lib/accounts'
import { json } from '@/lib/api'
import { baselineFor } from '@/lib/baseline'
import type { BlockConfig } from '@/lib/block'
import { avatarUrl } from '@/lib/avatar'
import { createDb } from '@/lib/db/client'
import { activities, type Block, blocks, planSessions, planWeeks } from '@/lib/db/schema'

export const prerender = false

/** The six fields the rest of the app knows as `BlockConfig` — `userId`/`updatedAt` are storage detail. */
const toBlockConfig = (row: Block): BlockConfig => ({
  startsOn: row.startsOn,
  raceOn: row.raceOn,
  goalTimeS: row.goalTimeS,
  raceDistanceM: row.raceDistanceM,
  raceName: row.raceName,
  racePlace: row.racePlace,
})

/**
 * Everything the UI needs for the signed-in athlete, in one request. One block is a few
 * tens of KB of activities, weeks and sessions, so splitting it across endpoints would buy
 * nothing but round trips. Matching plan to actuals and every metric derived from them
 * happens on the client, from exactly this payload.
 *
 * `block` is `null` for an athlete who has registered but not yet finished `/bienvenida`
 * — every list below is scoped to it, so they come back empty rather than unfiltered
 * until one exists.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!
  const db = createDb(env.DB)

  const [block, acts, weeks, sessions, account] = await Promise.all([
    db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) }),
    db.select().from(activities).where(eq(activities.userId, user.id)),
    db.select().from(planWeeks).where(eq(planWeeks.userId, user.id)).orderBy(planWeeks.weekIndex),
    db
      .select()
      .from(planSessions)
      .where(eq(planSessions.userId, user.id))
      .orderBy(planSessions.scheduledOn, planSessions.dayOrder),
    getAccount(db, user.id),
  ])

  return json({
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      isAdmin: user.isAdmin,
      hrMax: user.hrMax,
      baselineKey: user.baselineKey,
      // A boolean, never the hash: `/ajustes` only needs to know whether to offer "mint"
      // or "rotate", and the token itself exists in one response body and nowhere else.
      hasMcpToken: user.hasMcpToken,
      // The authenticated app URL, not the private R2 key. A new key means a new immutable
      // URL, so replacing a photo never has to invalidate the browser's old cache entry.
      avatarUrl: avatarUrl(user.id, user.avatarKey),
    },
    block: block ? toBlockConfig(block) : null,
    baseline: block ? baselineFor(user.baselineKey, toBlockConfig(block)) !== null : false,
    hasPlan: sessions.length > 0,
    stravaConnected: account !== null,
    athlete: account?.athlete ?? null,
    lastSyncAt: account?.lastSyncAt ?? null,
    // Sync only ever fetches from block.startsOn onward, but an athlete who pushes their
    // block start later after an earlier sync can still have older rows sitting in the
    // table — filtered here, in memory, so the query above stays a single indexed scan.
    activities: block ? acts.filter((a) => a.startedOn >= block.startsOn) : [],
    weeks,
    sessions,
  })
}
