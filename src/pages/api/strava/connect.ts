import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { randomToken } from '@/lib/crypto'
import { authorizeUrl } from '@/lib/strava'

export const prerender = false

/** Behind the auth middleware — only a signed-in session can start the OAuth flow. */
export const GET: APIRoute = async ({ url, redirect }) => {
  const state = randomToken(24)
  // Single-use CSRF token, held server-side so it cannot be forged.
  await env.CACHE.put(`oauth:${state}`, '1', { expirationTtl: 600 })
  return redirect(authorizeUrl(url.origin, state), 302)
}
