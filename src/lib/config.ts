import { env } from 'cloudflare:workers'
import type { OAuthConfig } from './strava/oauth'

/**
 * Reads secrets and vars off the Worker env, failing loudly at the point of use rather
 * than serving a half-configured request. Secrets are set with `wrangler secret put`.
 */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required Worker secret or var: ${name}`)
  return value
}

export function stravaOAuthConfig(origin: string): OAuthConfig {
  return {
    clientId: required('STRAVA_CLIENT_ID', env.STRAVA_CLIENT_ID),
    clientSecret: required('STRAVA_CLIENT_SECRET', env.STRAVA_CLIENT_SECRET),
    redirectUri: new URL('/api/auth/strava/callback', origin).toString(),
  }
}

export function tokenEncryptionKey(): string {
  return required('TOKEN_ENC_KEY', env.TOKEN_ENC_KEY)
}

export function webhookVerifyToken(): string {
  return required('STRAVA_WEBHOOK_VERIFY', env.STRAVA_WEBHOOK_VERIFY)
}

/**
 * Athlete IDs permitted to sign in. The schema is multi-user from day one, but the
 * gate keeps the deployment effectively single-athlete until that is a deliberate choice.
 */
export function allowlistedAthleteIds(): Set<number> {
  const raw = env.ALLOWED_ATHLETE_IDS ?? ''
  return new Set(
    raw
      .split(',')
      .map((id) => Number.parseInt(id.trim(), 10))
      .filter((id) => Number.isFinite(id)),
  )
}

export function isAllowlisted(athleteId: number): boolean {
  const allowed = allowlistedAthleteIds()
  // An empty allowlist is a misconfiguration, not "allow everyone".
  return allowed.size > 0 && allowed.has(athleteId)
}
