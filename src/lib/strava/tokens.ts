import { eq } from 'drizzle-orm'
import type { Database } from '../db/client'
import { oauthTokens } from '../db/schema'
import { decrypt, encrypt } from '../crypto'
import { StravaAuthError } from './errors'
import { expiresAtMs, refreshTokens, type OAuthConfig } from './oauth'
import type { StravaTokenResponse } from './types'

/** Refresh this far before actual expiry, so a long job never expires mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

export async function saveTokens(
  db: Database,
  athleteId: number,
  token: StravaTokenResponse,
  encKey: string,
  scope = '',
): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    encrypt(token.access_token, encKey),
    encrypt(token.refresh_token, encKey),
  ])

  const row = {
    athleteId,
    accessToken,
    refreshToken,
    expiresAt: expiresAtMs(token),
    scope,
    updatedAt: Date.now(),
  }

  await db
    .insert(oauthTokens)
    .values(row)
    .onConflictDoUpdate({ target: oauthTokens.athleteId, set: row })
}

async function loadTokens(
  db: Database,
  athleteId: number,
  encKey: string,
): Promise<StoredTokens | null> {
  const row = await db.query.oauthTokens.findFirst({
    where: eq(oauthTokens.athleteId, athleteId),
  })
  if (!row) return null

  const [accessToken, refreshToken] = await Promise.all([
    decrypt(row.accessToken, encKey),
    decrypt(row.refreshToken, encKey),
  ])

  return { accessToken, refreshToken, expiresAt: row.expiresAt, scope: row.scope }
}

/**
 * Returns a usable access token, refreshing it first when it is at or near expiry.
 *
 * Strava rotates the refresh token on every refresh, so the new pair must be persisted
 * — dropping it strands the athlete on a dead token and forces a manual reconnect.
 */
export async function getAccessToken(
  db: Database,
  athleteId: number,
  config: OAuthConfig,
  encKey: string,
  now: number = Date.now(),
): Promise<string> {
  const stored = await loadTokens(db, athleteId, encKey)
  if (!stored) throw new StravaAuthError(`No Strava tokens stored for athlete ${athleteId}`)

  if (stored.expiresAt - REFRESH_SKEW_MS > now) return stored.accessToken

  const refreshed = await refreshTokens(config, stored.refreshToken)
  await saveTokens(db, athleteId, refreshed, encKey, stored.scope)
  return refreshed.access_token
}
