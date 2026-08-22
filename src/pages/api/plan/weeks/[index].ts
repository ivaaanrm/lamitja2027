import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { TOTAL_WEEKS } from '@/lib/block'
import { createDb } from '@/lib/db/client'
import { planWeeks } from '@/lib/db/schema'
import { updateWeekInput } from '@/lib/plan-input'

export const prerender = false

/**
 * Upsert, not update: the 22 weeks are not seeded, so the first edit to a week is what
 * brings its row into existence. Nothing has to pre-create empty rows for a plan that is
 * still being written.
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const weekIndex = Number(params.index)
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= TOTAL_WEEKS) {
    return json({ error: `Week must be between 0 and ${TOTAL_WEEKS - 1}` }, 400)
  }

  const parsed = updateWeekInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const patch = { ...parsed.data, updatedAt: Date.now() }
  const [row] = await createDb(env.DB)
    .insert(planWeeks)
    .values({ weekIndex, ...patch })
    .onConflictDoUpdate({ target: planWeeks.weekIndex, set: patch })
    .returning()

  return json(row)
}
