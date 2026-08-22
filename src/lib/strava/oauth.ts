import { StravaAuthError } from './errors'
import type { StravaTokenResponse } from './types'

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize'
const TOKEN_URL = 'https://www.strava.com/oauth/token'

/**
 * `activity:read_all` is required to see private activities; without it the backfill
 * silently returns a partial history, which would quietly corrupt every volume metric.
 */
export const SCOPES = 'read,profile:read_all,activity:read_all'

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  // `auto` skips the consent screen on reconnect once already granted.
  url.searchParams.set('approval_prompt', 'auto')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  return url.toString()
}

async function postToken(body: Record<string, string>): Promise<StravaTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new StravaAuthError(`Strava token endpoint returned ${response.status}: ${detail}`)
  }

  return (await response.json()) as StravaTokenResponse
}

export function exchangeCode(config: OAuthConfig, code: string): Promise<StravaTokenResponse> {
  return postToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
  })
}

export function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
): Promise<StravaTokenResponse> {
  return postToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
}

/** Revokes the app's access. Strava calls this "deauthorize". */
export async function deauthorize(accessToken: string): Promise<void> {
  await fetch('https://www.strava.com/oauth/deauthorize', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  })
}

/** Strava reports `expires_at` in seconds; everything downstream is epoch ms. */
export function expiresAtMs(token: StravaTokenResponse): number {
  return token.expires_at * 1000
}
