import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { findByAthleteId } from '@/lib/accounts'
import { createDb } from '@/lib/db/client'
import { exchangeCode, saveTokens } from '@/lib/strava'
import { syncUser } from '@/lib/sync'

export const prerender = false

const back = (status: string) =>
  new Response(null, { status: 302, headers: { location: `/?strava=${status}` } })

export const GET: APIRoute = async ({ url, locals }) => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (url.searchParams.get('error') || !code || !state) return back('error')

  // Single-use: consume the state before doing anything else. Its value is the athlete who
  // started the flow — this route is public (Strava redirects the browser here, and the
  // grant is what authenticates it), so KV is what says whose connection this is.
  const userId = await env.CACHE.get(`oauth:${state}`)
  if (!userId) return back('bad_state')
  await env.CACHE.delete(`oauth:${state}`)

  // Without activity:read_all the sync silently misses private runs.
  if (!(url.searchParams.get('scope') ?? '').includes('activity:read_all')) {
    return back('scope')
  }

  const db = createDb(env.DB)
  const tokens = await exchangeCode(code)
  // The code exchange is the only response that carries the athlete, and the athlete id is
  // half the row — without it there is nothing to create the connection with, and nothing a
  // webhook could later find it by.
  const athleteId = tokens.athlete?.id
  if (!athleteId) return back('error')

  // One Strava athlete belongs to one login. Two would double-count the same runs into two
  // athletes' totals, and `strava_accounts.athlete_id` is unique anyway — so this answers
  // plainly instead of failing on the insert with the grant already spent.
  const existing = await findByAthleteId(db, athleteId)
  if (existing && existing.userId !== userId) return back('taken')

  await saveTokens(db, userId, tokens)

  // The block is one request, so the first sync rides along with the connect instead of
  // waiting for the cron — deferred, because a browser is sitting on this redirect.
  locals.cfContext?.waitUntil(
    syncUser(db, userId).catch((error) => console.error('[callback] sync failed', error)),
  )

  return back('ok')
}
