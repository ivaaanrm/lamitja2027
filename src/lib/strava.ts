import { env } from 'cloudflare:workers'
import { getAccount, upsertAccount } from './accounts'
import { decrypt, encrypt } from './crypto'
import type { Database } from './db/client'
import type { StravaAthlete } from './db/schema'
import type { StravaActivity } from './activity'
import type { StravaLap, StravaSplit, StravaStreams } from './streams'

/**
 * Everything Strava, in one file. Scope is a handful of athletes, each syncing one block of
 * ~23 weeks — a few API calls per athlete per day, nowhere near the 100-per-15-min read
 * limit, so there is still no budget tracker and no paginated backfill here.
 *
 * Nothing in here knows "the" Strava connection any more: every credential belongs to one
 * user, so every function that touches one takes the user it is about.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token'
const API_BASE = 'https://www.strava.com/api/v3'

/** `activity:read_all` is required to see private activities. */
const SCOPES = 'read,activity:read_all'

interface StravaTokens {
  access_token: string
  refresh_token: string
  expires_at: number // epoch seconds
  /** Present on the code exchange and absent on a refresh — see `saveTokens`. */
  athlete?: StravaAthlete
}

export interface StravaDetailedActivity extends StravaActivity {
  description?: string | null
  splits_metric?: StravaSplit[]
  laps?: StravaLap[]
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

/**
 * Persists one athlete's refresh token, encrypted. Strava rotates it on every refresh, so
 * this runs on every sync and not only at connect time — and a refresh response carries no
 * `athlete`, which is why the id and the profile are written only when they are there.
 * That is also what makes the connect callback the sole path that can *create* the row.
 */
export async function saveTokens(
  db: Database,
  userId: string,
  tokens: StravaTokens,
): Promise<void> {
  await upsertAccount(db, userId, {
    refreshToken: await encrypt(tokens.refresh_token, env.TOKEN_ENC_KEY),
    ...(tokens.athlete && { athleteId: tokens.athlete.id, athlete: tokens.athlete }),
  })
}

/**
 * Exchanges this athlete's stored refresh token for a fresh access token and persists the
 * rotated one. Access tokens are not cached: they last six hours, we sync a few times a
 * day, and one extra request is cheaper than reasoning about staleness.
 */
export async function accessToken(db: Database, userId: string): Promise<string> {
  const account = await getAccount(db, userId)
  // Surfaced verbatim by POST /api/sync, so it is written in the language of the app.
  if (!account) throw new Error('Strava no está conectado')

  const tokens = await postToken({
    refresh_token: await decrypt(account.refreshToken, env.TOKEN_ENC_KEY),
    grant_type: 'refresh_token',
  })
  await saveTokens(db, userId, tokens)
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


async function get<T>(token: string, path: string): Promise<T | null> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Strava ${path} ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as T
}

/**
 * The trace behind one activity, plus the detailed record that carries its splits and
 * laps. Read when a run is opened and never stored — see `streams.ts` for why. `null`
 * when Strava no longer has it (deleted there since the last sync).
 */
export async function fetchActivityDetail(
  token: string,
  id: number,
): Promise<{ streams: StravaStreams; activity: StravaDetailedActivity } | null> {
  const keys = 'time,distance,heartrate,cadence,velocity_smooth,altitude'
  const [streams, activity] = await Promise.all([
    get<StravaStreams>(token, `/activities/${id}/streams?keys=${keys}&key_by_type=true`),
    get<StravaDetailedActivity>(token, `/activities/${id}`),
  ])
  // An activity with no streams at all (a manual entry) still has a detailed record.
  return activity ? { streams: streams ?? {}, activity } : null
}
