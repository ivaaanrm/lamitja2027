import { desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { activities, laps, syncState, type NewActivity, type NewLap } from '../db/schema'
import type { StravaClient } from '../strava/client'
import { mapActivity, mapLap } from '../strava/mapper'
import type { StravaActivity } from '../strava/types'

/**
 * D1 binds at most **100 parameters per query** — far tighter than SQLite's own 999, and
 * the limit that actually bites here: activities carry 26 columns, so a naive 20-row
 * insert would send 520 parameters and fail outright.
 *
 * Derive the row count from the column count so adding a column can never silently push a
 * statement back over the edge.
 */
const D1_MAX_BOUND_PARAMS = 100

/** Statements per `db.batch()` call — one round trip instead of one per chunk. */
const STATEMENTS_PER_BATCH = 50

function rowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnCount))
}

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

  const perStatement = rowsPerStatement(Object.keys(getTableColumns(activities)).length)
  const statements = chunk(rows, perStatement).map((values) =>
    db.insert(activities).values(values).onConflictDoUpdate({
      target: activities.id,
      set: ACTIVITY_UPDATE_SET,
    }),
  )

  for (const group of chunk(statements, STATEMENTS_PER_BATCH)) {
    // A D1 batch is one transaction and one network round trip; a 200-activity page
    // becomes a couple of calls rather than seventy.
    await db.batch(group as [(typeof group)[number], ...typeof group])
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

  const perStatement = rowsPerStatement(Object.keys(getTableColumns(laps)).length)
  const statements = chunk(rows, perStatement).map((values) => db.insert(laps).values(values))

  for (const group of chunk(statements, STATEMENTS_PER_BATCH)) {
    await db.batch(group as [(typeof group)[number], ...typeof group])
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
