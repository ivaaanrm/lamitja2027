import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { blocks, planSessions } from '@/lib/db/schema'
import { sessionInputs } from '@/lib/plan-input'
import { unknownExerciseIds } from '@/lib/exercises/catalog'
import { strengthEntriesOf, unknownExercisesResponse } from '@/lib/templates'

export const prerender = false

/**
 * Adds a session to the plan. Ids are generated server-side: a hand-written plan has no
 * natural key, and letting the client pick one would let a stale tab overwrite a session
 * it never saw.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!
  const db = createDb(env.DB)

  // `scheduledOn` can only be validated against a block that exists — an athlete who has
  // not finished `/bienvenida` has nowhere for a session to land yet.
  const block = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!block) return json({ error: 'Primero completa la configuración del bloque' }, 400)

  const { createSessionInput } = sessionInputs(block)
  const parsed = createSessionInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  // A strength day prescribes catalogue exercises, and only the catalogue knows whether
  // its ids are real. A run's steps have none, so this is a no-op for every session that
  // was writable before templates existed.
  const exercises = strengthEntriesOf(parsed.data.steps)
  if (exercises) {
    const refused = unknownExercisesResponse(unknownExerciseIds(exercises), 'steps.exercises')
    if (refused) return refused
  }

  const row = { id: crypto.randomUUID(), userId: user.id, ...parsed.data, updatedAt: Date.now() }
  await db.insert(planSessions).values(row)
  return json(row, 201)
}
