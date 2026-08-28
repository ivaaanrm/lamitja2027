import { env } from 'cloudflare:workers'
import { timingSafeEqual } from './crypto'

/**
 * Sessions: a signed cookie carrying the athlete's user id.
 *
 * Strava OAuth is how the *server* gets an API token, not how a person signs in — making
 * it the login would mean re-authorising on every device. A form and a cookie rather than
 * HTTP Basic: an installed PWA on iOS gives no way to sign out of Basic auth, and the
 * browser prompt sits outside the app's own chrome.
 *
 * The mac is signed with `SESSION_SECRET` and never with `APP_PASSWORD` again: that one is
 * now the single-use bootstrap secret, and a value a person types must not double as the
 * key every device's cookie hangs from. Rotating `SESSION_SECRET` signs everyone out,
 * which is the panic button; there is no session table to revoke from.
 */
export interface ClientUser {
  id: string
  isAdmin: boolean
  displayName: string
  email: string
  hrMax: number | null
  /** Which frozen comparison season this athlete may read; null for everyone but its owner. */
  baselineKey: string | null
  /**
   * Whether this athlete has minted an MCP token — a boolean, never the hash and never the
   * token. `/ajustes` needs to know which of "mint" and "rotate" to offer and nothing more.
   */
  hasMcpToken: boolean
  /** Authenticated app URL for the current immutable avatar object, never its R2 key. */
  avatarUrl: string | null
}

/** The database-backed identity middleware closes over for one authenticated request. */
export interface SessionUser extends Omit<ClientUser, 'avatarUrl'> {
  /** Private storage detail used only by the authenticated avatar routes. */
  avatarKey: string | null
}

const COOKIE = 'lm_session'
const MAX_AGE_S = 365 * 24 * 60 * 60

async function sign(value: string): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not set')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `userId.issuedAt.hmac` — the mac covers `userId.issuedAt`, so neither can be swapped. */
export async function createSessionCookie(userId: string): Promise<string> {
  const value = `${userId}.${Date.now()}`
  const cookie = `${value}.${await sign(value)}`
  return `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

/**
 * Verifies the signature and nothing else — no database read, so the middleware decides
 * once per request whether that id still belongs to anyone. Null when absent or forged.
 */
export async function sessionUserId(request: Request): Promise<string | null> {
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
  if (!match) return null

  // Split from the right, twice: the mac comes off first, then the timestamp, so a user
  // id is never assumed to be free of dots.
  const raw = decodeURIComponent(match[1])
  const macAt = raw.lastIndexOf('.')
  if (macAt < 1) return null

  const value = raw.slice(0, macAt)
  if (!timingSafeEqual(raw.slice(macAt + 1), await sign(value))) return null

  const issuedAt = value.lastIndexOf('.')
  return issuedAt > 0 ? value.slice(0, issuedAt) : null
}

/**
 * The bootstrap secret, and only that. `APP_PASSWORD` no longer signs anyone in — it
 * authorises the single call that gives the owner row its first password hash.
 */
export function checkBootstrapSecret(candidate: string): boolean {
  const expected = env.APP_PASSWORD
  if (!expected) throw new Error('APP_PASSWORD is not set')
  return timingSafeEqual(candidate, expected)
}
