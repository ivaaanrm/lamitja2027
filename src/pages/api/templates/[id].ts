import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { workoutTemplates } from '@/lib/db/schema'
import { updateTemplateInput } from '@/lib/plan-input'
import { unknownExerciseIds } from '@/lib/exercises/catalog'
import { isBuiltInTemplateId } from '@/lib/starters'
import { unknownExercisesResponse } from '@/lib/templates'

export const prerender = false

/**
 * Partial update. An absent key leaves the column alone; an explicit `null` clears it.
 * `exercises` is the exception and replaces the whole list: an entry has no identity of
 * its own, so there is nothing for a partial update to address.
 *
 * Scoped by the *where clause* rather than by a read-then-check, which is the rule the
 * whole schema is keyed for: `id` is not a key here — the primary key is `(user_id, id)`,
 * and ids are hand-chosen slugs that two athletes will pick independently. A row that is
 * looked at before it is established whose it is has already been read.
 */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!
  const id = params.id
  if (!id) return json({ error: 'Falta el id de la plantilla' }, 400)
  // The built-ins ship in code and have no rows; the scoped update below would answer 404
  // anyway, but «no existe» is the wrong thing to tell somebody looking at one on screen.
  if (isBuiltInTemplateId(id)) {
    return json({ error: 'Las plantillas de Treximo no se editan: duplícala para hacerla tuya' }, 400)
  }

  const parsed = updateTemplateInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  if (parsed.data.exercises) {
    const refused = unknownExercisesResponse(unknownExerciseIds(parsed.data.exercises))
    if (refused) return refused
  }

  const [row] = await createDb(env.DB)
    .update(workoutTemplates)
    .set({ ...parsed.data, updatedAt: Date.now() })
    .where(and(eq(workoutTemplates.userId, user.id), eq(workoutTemplates.id, id)))
    .returning()

  return row ? json(row) : json({ error: 'No existe esa plantilla' }, 404)
}

/**
 * Removes a template. Sessions already stamped from it are untouched — they carry a copy,
 * which is the point of copying rather than referencing. Deleting the library entry cannot
 * blank a Monday that has already been trained.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user!
  const id = params.id
  if (!id) return json({ error: 'Falta el id de la plantilla' }, 400)
  if (isBuiltInTemplateId(id)) {
    return json({ error: 'Las plantillas de Treximo no se borran' }, 400)
  }

  const [row] = await createDb(env.DB)
    .delete(workoutTemplates)
    .where(and(eq(workoutTemplates.userId, user.id), eq(workoutTemplates.id, id)))
    .returning({ id: workoutTemplates.id })

  return row ? new Response(null, { status: 204 }) : json({ error: 'No existe esa plantilla' }, 404)
}
