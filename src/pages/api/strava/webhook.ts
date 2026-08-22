import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { timingSafeEqual } from '@/lib/crypto'
import { createDb } from '@/lib/db/client'
import { syncBlock } from '@/lib/sync'

export const prerender = false

/** Subscription validation — Strava expects the challenge echoed verbatim. */
export const GET: APIRoute = ({ url }) => {
  const challenge = url.searchParams.get('hub.challenge')
  const token = url.searchParams.get('hub.verify_token')

  if (url.searchParams.get('hub.mode') !== 'subscribe' || !challenge || !token) {
    return new Response('Bad request', { status: 400 })
  }
  if (!timingSafeEqual(token, env.STRAVA_WEBHOOK_VERIFY)) {
    return new Response('Bad verify token', { status: 403 })
  }
  return Response.json({ 'hub.challenge': challenge })
}

/**
 * Strava allows roughly two seconds before it treats delivery as failed and eventually
 * disables the subscription, so this returns immediately and re-syncs in `waitUntil`.
 * Since a sync is a single full-block fetch, the event body itself is not even needed —
 * any event just means "something changed, refresh".
 */
export const POST: APIRoute = ({ locals }) => {
  locals.cfContext?.waitUntil(
    syncBlock(createDb(env.DB)).catch((error) => console.error('[webhook] sync failed', error)),
  )
  return new Response('ok')
}
