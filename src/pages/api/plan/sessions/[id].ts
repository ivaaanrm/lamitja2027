import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { activities, blocks, planSessions } from '@/lib/db/schema'
import { sessionInputs } from '@/lib/plan-input'

export const prerender = false

/**
 * Partial update. An absent key leaves the column alone; an explicit `null` clears it —
 * which is how "remove the pace target" differs from "don't touch the pace target".
 */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!
  const id = params.id
  if (!id) return json({ error: 'Falta el id de la sesión' }, 400)

  const db = createDb(env.DB)
  const block = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!block) return json({ error: 'Primero completa la configuración del bloque' }, 400)

  const { updateSessionInput } = sessionInputs(block)
  const parsed = updateSessionInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  // `plan_sessions.activity_id` references `activities(id)` alone — Strava ids are global,
  // so the foreign key by itself would happily accept another athlete's activity. Ownership
  // has to be checked here, before the pin is allowed to land.
  if (parsed.data.activityId != null) {
    const owned = await db.query.activities.findFirst({
      where: and(eq(activities.id, parsed.data.activityId), eq(activities.userId, user.id)),
      columns: { id: true },
    })
    if (!owned) return json({ error: 'Esa actividad no existe' }, 400)
  }

  const [row] = await db
    .update(planSessions)
    .set({ ...parsed.data, updatedAt: Date.now() })
    .where(and(eq(planSessions.userId, user.id), eq(planSessions.id, id)))
    .returning()

  return row ? json(row) : json({ error: 'No existe esa sesión' }, 404)
}

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user!
  const id = params.id
  if (!id) return json({ error: 'Falta el id de la sesión' }, 400)

  const [row] = await createDb(env.DB)
    .delete(planSessions)
    .where(and(eq(planSessions.userId, user.id), eq(planSessions.id, id)))
    .returning({ id: planSessions.id })

  return row ? new Response(null, { status: 204 }) : json({ error: 'No existe esa sesión' }, 404)
}
