import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { deleteAccount } from '@/lib/accounts'
import { randomToken } from '@/lib/crypto'
import { createDb } from '@/lib/db/client'
import { authorizeUrl } from '@/lib/strava'

export const prerender = false

/** Behind the auth middleware — only a signed-in session can start the OAuth flow. */
export const GET: APIRoute = async ({ url, redirect, locals }) => {
  // Resolved by src/middleware.ts, which 401s before this route runs.
  const userId = locals.user!.id

  const state = randomToken(24)
  // Single-use, held server-side so it cannot be forged, and now carrying who started the
  // flow: Strava hands `state` back to a callback that is public by necessity, and the
  // browser arriving there is the only other thing tying the grant to an account.
  await env.CACHE.put(`oauth:${state}`, userId, { expirationTtl: 600 })
  return redirect(authorizeUrl(url.origin, state), 302)
}

/**
 * Disconnect — the other half of the same button on `/ajustes`, so it is the same route
 * rather than one of its own.
 *
 * Only the credential goes: the activities already synced are the athlete's training
 * record, not Strava's copy of it, and dropping them would empty every chart on the
 * strength of a tap meant to stop the nightly fetch. Reconnecting later re-fetches the
 * whole block anyway, so nothing is lost by keeping them.
 *
 * There is nothing to revoke at Strava's end from here — deauthorising is done in their
 * own settings, and the token this drops is the only thing that could have called it.
 */
export const DELETE: APIRoute = async ({ locals }) => {
  await deleteAccount(createDb(env.DB), locals.user!.id)
  return new Response(null, { status: 204 })
}
