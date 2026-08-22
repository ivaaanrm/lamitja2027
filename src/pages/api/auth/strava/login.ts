import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { stravaOAuthConfig } from '@/lib/config'
import { randomToken } from '@/lib/crypto'
import { buildAuthorizeUrl } from '@/lib/strava/oauth'

export const prerender = false

/** OAuth `state` is single-use and short-lived; 10 minutes is ample for a consent screen. */
const STATE_TTL_SECONDS = 600

export const GET: APIRoute = async ({ url, redirect }) => {
  const state = randomToken(24)

  // Held server-side in KV rather than a cookie so it cannot be replayed or forged,
  // and so the callback can prove this flow started here (CSRF).
  await env.CACHE.put(`oauth:state:${state}`, '1', { expirationTtl: STATE_TTL_SECONDS })

  return redirect(buildAuthorizeUrl(stravaOAuthConfig(url.origin), state), 302)
}
