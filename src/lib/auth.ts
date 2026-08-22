import { env } from 'cloudflare:workers'
import { timingSafeEqual } from './crypto'

/**
 * One athlete, one password, both devices.
 *
 * Strava OAuth is how the *server* gets an API token, not how a person signs in — making
 * it the login would mean re-authorising on every device. Instead a single `APP_PASSWORD`
 * secret gates the app, exchanged once for a long-lived signed cookie.
 *
 * A form and a cookie rather than HTTP Basic: an installed PWA on iOS gives no way to sign
 * out of Basic auth, and the browser prompt sits outside the app's own chrome.
 */
const COOKIE = 'lm_session'
const MAX_AGE_S = 365 * 24 * 60 * 60

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.APP_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function checkPassword(candidate: string): boolean {
  const expected = env.APP_PASSWORD
  if (!expected) throw new Error('APP_PASSWORD is not set')
  return timingSafeEqual(candidate, expected)
}

/** `issuedAt.signature` — the signature covers the timestamp, so the cookie is unforgeable. */
export async function createSessionCookie(): Promise<string> {
  const issuedAt = String(Date.now())
  const value = `${issuedAt}.${await sign(issuedAt)}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

export async function isSignedIn(request: Request): Promise<boolean> {
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
  if (!match) return false

  const [issuedAt, signature] = decodeURIComponent(match[1]).split('.')
  if (!issuedAt || !signature) return false

  // Rotating APP_PASSWORD invalidates every existing cookie, which is the intended
  // way to sign all devices out.
  return timingSafeEqual(signature, await sign(issuedAt))
}
