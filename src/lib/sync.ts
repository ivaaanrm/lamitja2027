import { getTableColumns, sql } from 'drizzle-orm'
import { BLOCK_START } from './block'
import type { Database } from './db/client'
import { activities } from './db/schema'
import { toRow } from './activity'
import { accessToken, fetchActivities } from './strava'
import { KEY, setState } from './state'

/**
 * D1 rejects any query with more than 100 bound parameters, so rows-per-statement is
 * derived from the column count rather than hardcoded — adding a column then cannot
 * silently push a statement over the limit.
 */
const D1_MAX_BOUND_PARAMS = 100

/** Every column but the id, so a re-sync picks up renames and corrected distances. */
const UPDATE_SET = Object.fromEntries(
  Object.entries(getTableColumns(activities))
    .filter(([key]) => key !== 'id')
    .map(([key, column]) => [key, sql`excluded.${sql.identifier(column.name)}`]),
)

/**
 * Pulls the whole block from Strava and upserts it.
 *
 * There is no cursor and no pagination: the block is 22 weeks and at most ~150 activities,
 * which is a single request. Always re-fetching the full window costs one API call and
 * removes every class of cursor-drift bug — a renamed or corrected activity self-heals on
 * the next sync.
 */
export async function syncBlock(db: Database): Promise<{ fetched: number }> {
  const token = await accessToken(db)
  const fetched = await fetchActivities(token, BLOCK_START)

  if (fetched.length > 0) {
    const columns = Object.keys(getTableColumns(activities)).length
    const perStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns))

    const statements = []
    for (let i = 0; i < fetched.length; i += perStatement) {
      statements.push(
        db
          .insert(activities)
          .values(fetched.slice(i, i + perStatement).map(toRow))
          .onConflictDoUpdate({ target: activities.id, set: UPDATE_SET }),
      )
    }
    await db.batch(statements as [(typeof statements)[number], ...typeof statements])
  }

  await setState(db, KEY.LAST_SYNC_AT, String(Date.now()))
  return { fetched: fetched.length }
}
