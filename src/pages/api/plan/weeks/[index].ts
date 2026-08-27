import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { totalWeeks } from '@/lib/block'
import { createDb } from '@/lib/db/client'
import { blocks, planWeeks } from '@/lib/db/schema'
import { updateWeekInput } from '@/lib/plan-input'

export const prerender = false

/**
 * Upsert, not update: a block's weeks are not seeded ahead of the plan that fills them, so
 * the first edit to a week is what brings its row into existence. Nothing has to
 * pre-create empty rows for a plan that is still being written.
 */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!
  const db = createDb(env.DB)

  const block = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!block) return json({ error: 'Primero completa la configuración del bloque' }, 400)

  const weekIndex = Number(params.index)
  const weeks = totalWeeks(block)
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= weeks) {
    return json({ error: `La semana debe estar entre 0 y ${weeks - 1}` }, 400)
  }

  const parsed = updateWeekInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const patch = { ...parsed.data, updatedAt: Date.now() }
  const [row] = await db
    .insert(planWeeks)
    .values({ userId: user.id, weekIndex, ...patch })
    .onConflictDoUpdate({ target: [planWeeks.userId, planWeeks.weekIndex], set: patch })
    .returning()

  return json(row)
}
