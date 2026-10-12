import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { d1GrantStore } from '@/lib/oauth/grants'

export const prerender = false

/**
 * Disconnects one application. Its access token stops working on the next MCP call and its
 * refresh token with it — the client finds out with a `401`, and has to ask the athlete
 * again. Scoped by `(userId, id)` in the delete itself, so an id from somebody else's list
 * deletes nothing.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
  const id = params.id
  if (!id) return json({ error: 'Falta el id de la conexión' }, 400)
  await d1GrantStore(createDb(env.DB)).revoke(locals.user!.id, id)
  return new Response(null, { status: 204 })
}
