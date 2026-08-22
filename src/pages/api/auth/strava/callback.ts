import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { isAllowlisted, stravaOAuthConfig, tokenEncryptionKey } from '@/lib/config'
import { createDb } from '@/lib/db/client'
import { athletes } from '@/lib/db/schema'
import { setSession } from '@/lib/auth/session'
import { exchangeCode } from '@/lib/strava/oauth'
import { saveTokens } from '@/lib/strava/tokens'
import { enqueue } from '@/lib/sync/jobs'
import { getSyncState } from '@/lib/sync/activities'

export const prerender = false

function failure(reason: string): Response {
  // Errors go back to the UI as a query param, never as a raw 500 — this is a page the
  // athlete lands on from Strava, not an API call.
  return new Response(null, {
    status: 302,
    headers: { location: `/?connect=error&reason=${encodeURIComponent(reason)}` },
  })
}

export const GET: APIRoute = async (context) => {
  const { url } = context
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) return failure(error)
  if (!code || !state) return failure('missing_code')

  // Single-use: consume the state before doing anything expensive.
  const stateKey = `oauth:state:${state}`
  const known = await env.CACHE.get(stateKey)
  if (!known) return failure('bad_state')
  await env.CACHE.delete(stateKey)

  const granted = url.searchParams.get('scope') ?? ''
  if (!granted.includes('activity:read_all')) {
    // Without it the history silently comes back partial, corrupting every volume metric.
    return failure('insufficient_scope')
  }

  const token = await exchangeCode(stravaOAuthConfig(url.origin), code)
  const athlete = token.athlete
  if (!athlete) return failure('no_athlete')

  if (!isAllowlisted(athlete.id)) return failure('not_allowlisted')

  const db = createDb(env.DB)
  const now = Date.now()

  await db
    .insert(athletes)
    .values({
      id: athlete.id,
      username: athlete.username,
      firstname: athlete.firstname,
      lastname: athlete.lastname,
      sex: athlete.sex,
      weightKg: athlete.weight,
      profileUrl: athlete.profile,
      country: athlete.country,
      allowlisted: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: athletes.id,
      set: {
        username: athlete.username,
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        weightKg: athlete.weight,
        profileUrl: athlete.profile,
        allowlisted: true,
        updatedAt: now,
      },
    })

  await saveTokens(db, athlete.id, token, tokenEncryptionKey(), granted)
  await setSession(context, { athleteId: athlete.id })

  // First connection kicks off the history walk; the cron pages through it from here.
  const state_ = await getSyncState(db, athlete.id)
  if (!state_.backfillComplete) {
    await enqueue(db, { athleteId: athlete.id, kind: 'backfill.page' })
  }

  return new Response(null, { status: 302, headers: { location: '/?connect=ok' } })
}
