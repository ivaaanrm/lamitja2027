import { env } from 'cloudflare:workers'
import type { Database } from '../db/client'
import { stravaOAuthConfig, tokenEncryptionKey } from '../config'
import { StravaClient } from './client'
import { getAccessToken } from './tokens'

/**
 * Builds an authenticated client for an athlete, refreshing the token if needed.
 *
 * `origin` only feeds the OAuth redirect_uri, which refresh does not use — but Strava
 * validates the client credentials, so the same config object is threaded through.
 */
export async function stravaClientFor(
  db: Database,
  athleteId: number,
  origin: string,
): Promise<StravaClient> {
  const accessToken = await getAccessToken(
    db,
    athleteId,
    stravaOAuthConfig(origin),
    tokenEncryptionKey(),
  )

  return new StravaClient({ accessToken, kv: env.CACHE })
}
