import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { d1GrantStore } from '@/lib/oauth/grants'

export const prerender = false

/**
 * The athlete's connected applications, for `/ajustes`: who, since when, last refreshed.
 *
 * Projected rather than returned whole — the row holds four credential hashes and the
 * PKCE challenge, none of which the screen has any use for, and a hash that never leaves
 * the Worker is one fewer thing to reason about.
 */
export const GET: APIRoute = async ({ locals }) => {
  const rows = await d1GrantStore(createDb(env.DB)).list(locals.user!.id, Date.now())
  return json({
    grants: rows.map((grant) => ({
      id: grant.id,
      clientName: grant.clientName,
      clientHost: grant.clientHost,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    })),
  })
}
