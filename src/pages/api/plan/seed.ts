import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { getTableColumns, sql } from 'drizzle-orm'
import { json } from '@/lib/api'
import { createDb, type Database } from '@/lib/db/client'
import { planSessions, planWeeks } from '@/lib/db/schema'
import { buildPlan } from '@/lib/seed'

export const prerender = false

/** D1 rejects a query with more than 100 bound parameters. */
const D1_MAX_BOUND_PARAMS = 100

/** Every column but the key, so re-seeding overwrites rather than skipping. */
const updateSet = (table: typeof planWeeks | typeof planSessions, key: string) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => name !== key)
      .map(([name, column]) => [name, sql`excluded.${sql.identifier(column.name)}`]),
  )

const chunkSize = (table: typeof planWeeks | typeof planSessions) =>
  Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / Object.keys(getTableColumns(table)).length))

/**
 * Writes the block from docs/03 into the database.
 *
 * Deliberately destructive of hand edits: session ids are derived from week and weekday,
 * so re-seeding resets every session back to the designed plan. That is the point — this
 * is "reset to the plan", not "merge with the plan".
 */
export const POST: APIRoute = async () => {
  const db: Database = createDb(env.DB)
  const now = Date.now()

  const { weeks, sessions } = buildPlan(now)

  const weekStmts = []
  for (let i = 0; i < weeks.length; i += chunkSize(planWeeks)) {
    weekStmts.push(
      db
        .insert(planWeeks)
        .values(weeks.slice(i, i + chunkSize(planWeeks)))
        .onConflictDoUpdate({ target: planWeeks.weekIndex, set: updateSet(planWeeks, 'weekIndex') }),
    )
  }

  const sessionStmts = []
  for (let i = 0; i < sessions.length; i += chunkSize(planSessions)) {
    sessionStmts.push(
      db
        .insert(planSessions)
        .values(sessions.slice(i, i + chunkSize(planSessions)))
        .onConflictDoUpdate({ target: planSessions.id, set: updateSet(planSessions, 'id') }),
    )
  }

  await db.batch(weekStmts as [(typeof weekStmts)[number], ...typeof weekStmts])
  await db.batch(sessionStmts as [(typeof sessionStmts)[number], ...typeof sessionStmts])

  return json({ weeks: weeks.length, sessions: sessions.length })
}
