import type { APIRoute } from 'astro'
import { z } from 'zod'
import { invalid, json } from '@/lib/api'
import {
  BODY_PARTS,
  CATEGORIES,
  DEFAULT_RESULTS,
  EQUIPMENT,
  MAX_RESULTS,
  MUSCLES,
  TAGS,
  searchExercises,
  type CatalogExercise,
} from '@/lib/exercises/catalog'

export const prerender = false

/**
 * The exercise search — a search *box*, and deliberately nothing more.
 *
 * The catalogue is 571 rows of vendored third-party prose (~650 KB) that lives in the
 * Worker and never reaches the browser. This is how the picker asks it a question. Three
 * properties of the answer are licence terms rather than tuning, and none of them should
 * be relaxed without reading `src/lib/exercises/LICENSE.md` first:
 *
 *   - **A query is required.** Two characters of text, or at least one facet. There is no
 *     request this endpoint answers with "everything".
 *   - **At most fifty rows, trimmed.** No description, no instructions, no tips — the
 *     fields a picker row actually draws and nothing else. The full record comes back one
 *     at a time from `/api/exercises/[id]`.
 *   - **No cursor, no offset, no page.** Which is also the house rule (this app has no
 *     pagination anywhere), so the two agree: there is no way to walk the set.
 *
 * Behind the default-closed middleware like every other `/api` route, so it is signed-in
 * athletes only. `no-store` is `json()`'s own default: search is online-only and that is
 * fine, because a template denormalises the Spanish name it was prescribed under and
 * therefore renders offline with no catalogue in reach.
 */

/**
 * Facets are validated against the vocabularies the catalogue generates, so `muscle=glutes`
 * comes back as a 400 naming the field rather than as an empty result set that reads like
 * "there is no such exercise".
 */
const query = z.object({
  q: z.string().trim().max(60).optional(),
  muscle: z.enum(MUSCLES).optional(),
  equipment: z.enum(EQUIPMENT).optional(),
  tag: z.enum(TAGS).optional(),
  bodyPart: z.enum(BODY_PARTS).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** `?bodyweight=1` — moves that need nothing at all. */
  bodyweight: z.literal('1').optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
})

/** What a picker row draws. Never the prose: see the licence note above. */
const trim = (exercise: CatalogExercise) => ({
  id: exercise.id,
  name: exercise.name,
  category: exercise.category,
  equipment: exercise.equipment,
  bodyPart: exercise.bodyPart,
  difficulty: exercise.difficulty,
  isUnilateral: exercise.isUnilateral,
})

export const GET: APIRoute = ({ url }) => {
  const parsed = query.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) return invalid(parsed.error)

  const { q, muscle, equipment, tag, bodyPart, category, bodyweight, limit } = parsed.data
  const text = q ?? ''
  const faceted = Boolean(muscle || equipment || tag || bodyPart || category || bodyweight)

  // One character matches a third of the catalogue and answers no question anyone asked;
  // no text and no facet is a request for the dataset. Both are refused here rather than
  // capped, so the message says what to do next.
  if (text.length < 2 && !faceted) {
    return json({ error: 'Afina la búsqueda: escribe al menos dos letras o elige un filtro' }, 400)
  }

  const results = searchExercises({
    q: text || undefined,
    muscle,
    equipment,
    tags: tag ? [tag] : undefined,
    bodyPart,
    category,
    bodyweightOnly: bodyweight === '1',
    limit: limit ?? DEFAULT_RESULTS,
  })

  return json({ results: results.map(trim) })
}
