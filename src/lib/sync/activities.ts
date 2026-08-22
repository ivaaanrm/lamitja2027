import { desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { activities, laps, syncState, type NewActivity, type NewLap } from '../db/schema'
import type { StravaClient } from '../strava/client'
import { mapActivity, mapLap } from '../strava/mapper'
import type { StravaActivity } from '../strava/types'

/**
 * SQLite binds at most 999 variables per statement. Activities carry ~26 columns, so
 * chunk well under that rather than discovering the ceiling on a big backfill page.
 */
const ACTIVITY_CHUNK = 20
const LAP_CHUNK = 40

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Every column except the identity ones, so a re-sync corrects any field Strava changed
 * (a renamed activity, a corrected distance) without listing 26 columns by hand.
 */
const ACTIVITY_UPDATE_SET = Object.fromEntries(
  Object.entries(getTableColumns(activities))
    .filter(([key]) => !['id', 'athleteId', 'createdAt'].includes(key))
    .map(([key, column]) => [key, sql`excluded.${sql.identifier(column.name)}`]),
)

export async function upsertActivities(db: Database, rows: NewActivity[]): Promise<number> {
  if (rows.length === 0) return 0

  for (const batch of chunk(rows, ACTIVITY_CHUNK)) {
    await db
      .insert(activities)
      .values(batch)
      .onConflictDoUpdate({ target: activities.id, set: ACTIVITY_UPDATE_SET })
  }

  return rows.length
}

export async function upsertLaps(
  db: Database,
  activityId: number,
  rows: NewLap[],
): Promise<number> {
  // Laps are immutable once recorded; replacing wholesale avoids a per-lap diff and
  // self-heals if Strava renumbers them after an edit.
  await db.delete(laps).where(eq(laps.activityId, activityId))
  if (rows.length === 0) return 0

  for (const batch of chunk(rows, LAP_CHUNK)) {
    await db.insert(laps).values(batch)
  }

  await db.update(activities).set({ hasLaps: true }).where(eq(activities.id, activityId))
  return rows.length
}

export async function getSyncState(db: Database, athleteId: number) {
  const existing = await db.query.syncState.findFirst({
    where: eq(syncState.athleteId, athleteId),
  })
  if (existing) return existing

  const fresh = { athleteId, lastActivityAt: 0, backfillComplete: false, updatedAt: Date.now() }
  await db.insert(syncState).values(fresh).onConflictDoNothing()
  return { ...fresh, backfillBefore: null, lastFullSyncAt: null }
}

/** Strava's `after`/`before` bounds are epoch **seconds**. */
const toStravaSeconds = (ms: number) => Math.floor(ms / 1000)

export interface SyncResult {
  fetched: number
  upserted: number
  newest: number
}

/**
 * Pulls everything newer than the last activity we hold. Used by the nightly cron and by
 * a manual re-sync; webhooks handle the common single-activity case on their own.
 */
export async function syncRecentActivities(
  db: Database,
  client: StravaClient,
  athleteId: number,
  now: number = Date.now(),
): Promise<SyncResult> {
  const state = await getSyncState(db, athleteId)

  const fetched: StravaActivity[] = []
  let page = 1

  // `after` returns oldest-first, so keep paging until a short page ends the run.
  for (;;) {
    const batch = await client.getActivities({
      after: toStravaSeconds(state.lastActivityAt),
      page,
      perPage: 200,
    })
    fetched.push(...batch)
    if (batch.length < 200) break
    page += 1
  }

  const rows = fetched.map((activity) => mapActivity(activity, athleteId, now))
  const upserted = await upsertActivities(db, rows)
  const newest = rows.reduce((max, row) => Math.max(max, row.startAt), state.lastActivityAt)

  await db
    .update(syncState)
    .set({ lastActivityAt: newest, lastFullSyncAt: now, updatedAt: now })
    .where(eq(syncState.athleteId, athleteId))

  return { fetched: fetched.length, upserted, newest }
}

export interface BackfillResult extends SyncResult {
  complete: boolean
  oldest: number | null
}

/**
 * One page of history, walking backwards. Deliberately does a single page per call so the
 * caller (the quarter-hourly cron) stays inside the read-rate budget; it re-enqueues
 * itself until `complete`.
 */
export async function backfillPage(
  db: Database,
  client: StravaClient,
  athleteId: number,
  now: number = Date.now(),
): Promise<BackfillResult> {
  const state = await getSyncState(db, athleteId)

  if (state.backfillComplete) {
    return { fetched: 0, upserted: 0, newest: state.lastActivityAt, complete: true, oldest: null }
  }

  const before = state.backfillBefore ?? now
  const batch = await client.getActivities({
    before: toStravaSeconds(before),
    perPage: 200,
  })

  const rows = batch.map((activity) => mapActivity(activity, athleteId, now))
  const upserted = await upsertActivities(db, rows)

  // An empty or short page means we have reached the beginning of their Strava history.
  const complete = batch.length < 200
  const oldest = rows.length > 0 ? Math.min(...rows.map((r) => r.startAt)) : null
  const newest = rows.reduce((max, row) => Math.max(max, row.startAt), state.lastActivityAt)

  await db
    .update(syncState)
    .set({
      backfillBefore: oldest ?? state.backfillBefore,
      backfillComplete: complete,
      lastActivityAt: newest,
      updatedAt: now,
    })
    .where(eq(syncState.athleteId, athleteId))

  return { fetched: batch.length, upserted, newest, complete, oldest }
}

export async function deleteActivity(db: Database, activityId: number): Promise<void> {
  await db.delete(activities).where(eq(activities.id, activityId))
}

export async function activityCount(db: Database, athleteId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
  return row?.count ?? 0
}

export async function latestActivity(db: Database, athleteId: number) {
  return db.query.activities.findFirst({
    where: eq(activities.athleteId, athleteId),
    orderBy: desc(activities.startAt),
  })
}

export { mapLap }
