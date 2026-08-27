import { eq, getTableColumns, sql } from 'drizzle-orm'
import { setLastSync } from './accounts'
import { toRow } from './activity'
import type { BlockConfig } from './block'
import type { Database } from './db/client'
import { activities, blocks } from './db/schema'
import { accessToken, fetchActivities } from './strava'

/**
 * D1 rejects any query with more than 100 bound parameters, so rows-per-statement is
 * derived from the column count rather than hardcoded — adding a column then cannot
 * silently push a statement over the limit.
 */
const D1_MAX_BOUND_PARAMS = 100

/**
 * Every column but the two that say *which row this is*, so a re-sync picks up renames and
 * corrected distances without ever rewriting ownership.
 */
const UPDATE_SET = Object.fromEntries(
  Object.entries(getTableColumns(activities))
    .filter(([key]) => key !== 'id' && key !== 'userId')
    .map(([key, column]) => [key, sql`excluded.${sql.identifier(column.name)}`]),
)

/** Who to sync, and the window to sync: the id stamps the rows, the block starts them. */
export interface SyncUser {
  id: string
  block: BlockConfig
}

/**
 * Pulls one athlete's whole block from Strava and upserts it.
 *
 * There is no cursor and no pagination: a block is ~23 weeks and at most ~150 activities,
 * which is a single request. Always re-fetching the full window costs one API call and
 * removes every class of cursor-drift bug — a renamed or corrected activity self-heals on
 * the next sync.
 */
export async function syncBlock(db: Database, user: SyncUser): Promise<{ fetched: number }> {
  const token = await accessToken(db, user.id)
  const fetched = await fetchActivities(token, user.block.startsOn)

  if (fetched.length > 0) {
    const columns = Object.keys(getTableColumns(activities)).length
    const perStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns))

    const statements = []
    for (let i = 0; i < fetched.length; i += perStatement) {
      statements.push(
        db
          .insert(activities)
          .values(
            fetched
              .slice(i, i + perStatement)
              .map((activity) => ({ ...toRow(activity), userId: user.id })),
          )
          // A Strava activity id is globally unique, so the conflict is normally this
          // athlete's own earlier copy. `setWhere` keeps it that way: if an id somehow
          // already belongs to someone else — one Strava account reconnected under a second
          // login — the row is left untouched rather than quietly changing hands.
          .onConflictDoUpdate({
            target: activities.id,
            set: UPDATE_SET,
            setWhere: eq(activities.userId, user.id),
          }),
      )
    }
    await db.batch(statements as [(typeof statements)[number], ...typeof statements])
  }

  await setLastSync(db, user.id, Date.now())
  return { fetched: fetched.length }
}

/**
 * The door the webhook, the cron and the OAuth callback come in through: they know a user
 * id and nothing else, so the block has to be read before the window exists.
 *
 * `null` for an athlete who has connected Strava but not yet set a block — the onboarding
 * order makes that a narrow window, and syncing without `startsOn` would mean fetching
 * every run since the account was opened, which is not the single-page request this file
 * is built on.
 */
export async function syncUser(
  db: Database,
  userId: string,
): Promise<{ fetched: number } | null> {
  const block = await db.query.blocks.findFirst({ where: eq(blocks.userId, userId) })
  if (!block) return null
  return syncBlock(db, { id: userId, block })
}
