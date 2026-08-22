import { env } from 'cloudflare:workers'
import { decrypt, encrypt } from './crypto'
import type { Database } from './db/client'
import { getState, KEY, setState } from './state'
import type { StravaActivity } from './activity'

/**
 * Everything Strava, in one file. Scope is one athlete syncing one 22-week block, which
 * is a handful of API calls a day — nowhere near the 100-per-15-min read limit, so there
 * is no budget tracker and no paginated backfill here.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token'
const API_BASE = 'https://www.strava.com/api/v3'

/** `activity:read_all` is required to see private activities. */
export const SCOPES = 'read,activity:read_all'

export interface StravaTokens {
  access_token: string
  refresh_token: string
  expires_at: number // epoch seconds
  athlete?: { id: number; firstname: string | null; lastname: string | null; profile: string | null }
}

export function authorizeUrl(origin: string, state: string): string {
  const url = new URL('https://www.strava.com/oauth/authorize')
  url.searchParams.set('client_id', env.STRAVA_CLIENT_ID)
  url.searchParams.set('redirect_uri', new URL('/api/strava/callback', origin).toString())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('approval_prompt', 'auto')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  return url.toString()
}

async function postToken(body: Record<string, string>): Promise<StravaTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...body,
    }),
  })
  if (!response.ok) {
    throw new Error(`Strava token endpoint ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as StravaTokens
}

export const exchangeCode = (code: string) =>
  postToken({ code, grant_type: 'authorization_code' })

/** Persists the refresh token encrypted; Strava rotates it on every refresh. */
export async function saveTokens(db: Database, tokens: StravaTokens): Promise<void> {
  await setState(
    db,
    KEY.STRAVA_REFRESH_TOKEN,
    await encrypt(tokens.refresh_token, env.TOKEN_ENC_KEY),
  )
  if (tokens.athlete) {
    await setState(db, KEY.STRAVA_ATHLETE, JSON.stringify(tokens.athlete))
  }
}

/**
 * Exchanges the stored refresh token for a fresh access token and persists the rotated
 * refresh token. Access tokens are not cached: they last six hours, we sync a few times a
 * day, and one extra request is cheaper than reasoning about staleness.
 */
export async function accessToken(db: Database): Promise<string> {
  const stored = await getState(db, KEY.STRAVA_REFRESH_TOKEN)
  if (!stored) throw new Error('Strava is not connected')

  const tokens = await postToken({
    refresh_token: await decrypt(stored, env.TOKEN_ENC_KEY),
    grant_type: 'refresh_token',
  })
  await saveTokens(db, tokens)
  return tokens.access_token
}

/** Activities started after `after` (epoch ms), newest first. */
export async function fetchActivities(
  token: string,
  after: number,
  perPage = 200,
): Promise<StravaActivity[]> {
  const url = new URL(`${API_BASE}/athlete/activities`)
  url.searchParams.set('after', String(Math.floor(after / 1000)))
  url.searchParams.set('per_page', String(perPage))

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) {
    throw new Error(`Strava activities ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as StravaActivity[]
}

