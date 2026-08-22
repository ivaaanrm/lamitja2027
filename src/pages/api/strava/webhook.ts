import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { webhookVerifyToken } from '@/lib/config'
import { timingSafeEqual } from '@/lib/crypto'
import { createDb } from '@/lib/db/client'
import { enqueue } from '@/lib/sync/jobs'
import { drainJobs } from '@/lib/sync/runner'
import type { StravaWebhookEvent } from '@/lib/strava/types'

export const prerender = false

/**
 * Subscription validation. Strava GETs this once when the subscription is created and
 * expects the challenge echoed back verbatim.
 */
export const GET: APIRoute = async ({ url }) => {
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode !== 'subscribe' || !challenge || !token) {
    return new Response('Bad subscription request', { status: 400 })
  }
  if (!timingSafeEqual(token, webhookVerifyToken())) {
    return new Response('Bad verify token', { status: 403 })
  }

  return new Response(JSON.stringify({ 'hub.challenge': challenge }), {
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Event delivery. Strava gives roughly two seconds before it treats the delivery as
 * failed, so this only writes an outbox row and returns — the actual API calls happen in
 * `waitUntil`, and the quarter-hourly cron picks up anything that drop misses.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  let event: StravaWebhookEvent
  try {
    event = (await request.json()) as StravaWebhookEvent
  } catch {
    return new Response('Bad JSON', { status: 400 })
  }

  // Always 200 for anything well-formed. A non-2xx makes Strava retry and eventually
  // disable the subscription, and we would rather drop one event than lose the hook.
  if (event.object_type !== 'activity') {
    return new Response('ok', { status: 200 })
  }

  const db = createDb(env.DB)

  const kind =
    event.aspect_type === 'delete' ? ('activity.delete' as const) : ('activity.upsert' as const)

  await enqueue(db, {
    athleteId: event.owner_id,
    kind,
    payload: { activityId: event.object_id, aspect: event.aspect_type },
  })

  // Best-effort immediate processing; failures just wait for the cron.
  locals.cfContext?.waitUntil(
    drainJobs(db, url.origin).catch((error) => {
      console.error('[webhook] inline drain failed', error)
    }),
  )

  return new Response('ok', { status: 200 })
}
