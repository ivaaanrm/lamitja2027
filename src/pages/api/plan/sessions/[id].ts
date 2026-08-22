import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { planSessions } from '@/lib/db/schema'
import { updateSessionInput } from '@/lib/plan-input'

export const prerender = false

/**
 * Partial update. An absent key leaves the column alone; an explicit `null` clears it —
 * which is how "remove the pace target" differs from "don't touch the pace target".
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const id = params.id
  if (!id) return json({ error: 'Missing session id' }, 400)

  const parsed = updateSessionInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const [row] = await createDb(env.DB)
    .update(planSessions)
    .set({ ...parsed.data, updatedAt: Date.now() })
    .where(eq(planSessions.id, id))
    .returning()

  return row ? json(row) : json({ error: 'No such session' }, 404)
}

export const DELETE: APIRoute = async ({ params }) => {
  const id = params.id
  if (!id) return json({ error: 'Missing session id' }, 400)

  const [row] = await createDb(env.DB)
    .delete(planSessions)
    .where(eq(planSessions.id, id))
    .returning({ id: planSessions.id })

  return row ? new Response(null, { status: 204 }) : json({ error: 'No such session' }, 404)
}
