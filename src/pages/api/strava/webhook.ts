import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { findByAthleteId } from '@/lib/accounts'
import { readJson } from '@/lib/api'
import { timingSafeEqual } from '@/lib/crypto'
import { createDb, type Database } from '@/lib/db/client'
import { syncUser } from '@/lib/sync'

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

/** The one field that matters: which Strava athlete the event is about. */
interface WebhookEvent {
  owner_id?: number
}

/**
 * Resolves the athlete and re-fetches their block. Deferred rather than awaited so the
 * lookup is not on the response's two-second budget.
 */
async function syncOwner(db: Database, ownerId: number): Promise<void> {
  const account = await findByAthleteId(db, ownerId)
  // An athlete nobody here is connected to: a subscription left over from another
  // deployment, or a user who disconnected between the event and its delivery. It is a log
  // line and never a failed delivery — Strava disables a subscription that errors, and one
  // stranger's event would take the webhook down for every athlete on it.
  if (!account) {
    console.warn(`[webhook] unknown athlete ${ownerId}`)
    return
  }
  await syncUser(db, account.userId)
}

/**
 * Strava allows roughly two seconds before it treats delivery as failed and eventually
 * disables the subscription, so this returns immediately and re-syncs in `waitUntil`.
 *
 * The body is read for exactly one field. With several athletes connected, "something
 * changed, refresh" is no longer a complete instruction: `owner_id` is the only thing in
 * the event that says whose block moved. Everything else is still ignored — a sync is one
 * full-block fetch, so which activity changed and how makes no difference to the work.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const ownerId = ((await readJson(request)) as WebhookEvent | null)?.owner_id
  if (typeof ownerId !== 'number') return new Response('ok')

  locals.cfContext?.waitUntil(
    syncOwner(createDb(env.DB), ownerId).catch((error) =>
      console.error('[webhook] sync failed', error),
    ),
  )
  return new Response('ok')
}
