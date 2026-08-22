import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { planSessions } from '@/lib/db/schema'
import { createSessionInput } from '@/lib/plan-input'

export const prerender = false

/**
 * Adds a session to the plan. Ids are generated server-side: a hand-written plan has no
 * natural key, and letting the client pick one would let a stale tab overwrite a session
 * it never saw.
 */
export const POST: APIRoute = async ({ request }) => {
  const parsed = createSessionInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const row = { id: crypto.randomUUID(), ...parsed.data, updatedAt: Date.now() }
  await createDb(env.DB).insert(planSessions).values(row)
  return json(row, 201)
}
