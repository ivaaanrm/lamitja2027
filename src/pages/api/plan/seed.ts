import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { getTableColumns, sql } from 'drizzle-orm'
import { json } from '@/lib/api'
import { BASELINE_KEY } from '@/lib/baseline'
import { createDb, type Database } from '@/lib/db/client'
import { planSessions, planWeeks } from '@/lib/db/schema'
import { buildPlan } from '@/lib/seed'

export const prerender = false

/** D1 rejects a query with more than 100 bound parameters. */
const D1_MAX_BOUND_PARAMS = 100

/** Every column but the key, so re-seeding overwrites rather than skipping. */
const updateSet = (table: typeof planWeeks | typeof planSessions, keys: string[]) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => !keys.includes(name))
      .map(([name, column]) => [name, sql`excluded.${sql.identifier(column.name)}`]),
  )

const chunkSize = (table: typeof planWeeks | typeof planSessions) =>
  Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / Object.keys(getTableColumns(table)).length))

/**
 * Writes docs/03's hand-written block into the database — for the owner alone. `buildPlan`
 * is Ivan's plan against `LAMITJA_2027`, not a template, so it is gated on the one
 * `baselineKey` that names that season rather than on `isAdmin`: an admin who invited
 * everyone else writes their own, in `/plan` or through their MCP endpoint.
 *
 * Deliberately destructive of hand edits: session ids are derived from week and weekday,
 * so re-seeding resets every session back to the designed plan. That is the point — this
 * is "reset to the plan", not "merge with the plan".
 */
export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user!
  if (user.baselineKey !== BASELINE_KEY) return json({ error: 'No autorizado' }, 403)

  const db: Database = createDb(env.DB)
  const now = Date.now()

  const { weeks, sessions } = buildPlan(now)
  const weekRows = weeks.map((week) => ({ ...week, userId: user.id }))
  const sessionRows = sessions.map((session) => ({ ...session, userId: user.id }))

  const weekStmts = []
  for (let i = 0; i < weekRows.length; i += chunkSize(planWeeks)) {
    weekStmts.push(
      db
        .insert(planWeeks)
        .values(weekRows.slice(i, i + chunkSize(planWeeks)))
        .onConflictDoUpdate({
          target: [planWeeks.userId, planWeeks.weekIndex],
          set: updateSet(planWeeks, ['userId', 'weekIndex']),
        }),
    )
  }

  const sessionStmts = []
  for (let i = 0; i < sessionRows.length; i += chunkSize(planSessions)) {
    sessionStmts.push(
      db
        .insert(planSessions)
        .values(sessionRows.slice(i, i + chunkSize(planSessions)))
        .onConflictDoUpdate({
          target: [planSessions.userId, planSessions.id],
          set: updateSet(planSessions, ['userId', 'id']),
        }),
    )
  }

  await db.batch(weekStmts as [(typeof weekStmts)[number], ...typeof weekStmts])
  await db.batch(sessionStmts as [(typeof sessionStmts)[number], ...typeof sessionStmts])

  return json({ weeks: weekRows.length, sessions: sessionRows.length })
}
