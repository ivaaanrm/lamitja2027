import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { workoutTemplates } from '@/lib/db/schema'
import { createTemplateInput } from '@/lib/plan-input'
import { unknownExerciseIds } from '@/lib/exercises/catalog'
import { unknownExercisesResponse } from '@/lib/templates'

export const prerender = false

/**
 * Adds a template to the athlete's library.
 *
 * Ids are generated server-side, exactly as `plan/sessions.ts` does and for the same
 * reason: a stale tab holding a template it opened last week must not be able to overwrite
 * the one that replaced it. (The MCP surface diverges deliberately and takes a chosen id,
 * because an agent re-running an authoring call is the opposite case — `tools.ts` says so
 * in place.)
 *
 * There is no block lookup here, and that absence is the table's whole argument: a
 * template carries no date, so there is nothing for a block to validate it against and an
 * athlete who has not finished `/bienvenida` can still write one. Name collisions are
 * allowed — a name is a label, not a key.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!

  const parsed = createTemplateInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  // zod knows the shape; only the catalogue knows whether the ids in it are real.
  const refused = unknownExercisesResponse(unknownExerciseIds(parsed.data.exercises))
  if (refused) return refused

  const row = { id: crypto.randomUUID(), userId: user.id, ...parsed.data, updatedAt: Date.now() }
  await createDb(env.DB).insert(workoutTemplates).values(row)
  return json(row, 201)
}
