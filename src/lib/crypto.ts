/**
 * AES-GCM helpers for data that must not be readable from a database dump.
 *
 * Used for Strava OAuth tokens: a leaked D1 export would otherwise hand over full
 * `activity:read_all` access to the athlete's account.
 *
 * Wire format is `base64(iv ‖ ciphertext)` with a fresh random 96-bit IV per call,
 * which is the size AES-GCM is specified for and lets us keep the nonce inline.
 */

const IV_BYTES = 12

/** Exported so `password.ts` derives its base64 through the one implementation here. */
export function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Imports a base64-encoded 256-bit key. Generate one with `openssl rand -base64 32`. */
async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key)
  if (raw.byteLength !== 32) {
    throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes, got ${raw.byteLength}`)
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encrypt(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )

  const packed = new Uint8Array(new ArrayBuffer(iv.byteLength + ciphertext.byteLength))
  packed.set(iv, 0)
  packed.set(new Uint8Array(ciphertext), iv.byteLength)
  return bytesToBase64(packed)
}

export async function decrypt(packed: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const bytes = base64ToBytes(packed)
  const iv = bytes.subarray(0, IV_BYTES)
  const ciphertext = bytes.subarray(IV_BYTES)

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/** Constant-time string compare, for verify tokens and webhook secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/** base64url with no padding (RFC 4648 §5) — the alphabet a URL, a header and a form carry unescaped. */
export function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The inverse of `bytesToBase64Url`. Throws on anything outside the alphabet, as `atob` does. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

/** URL-safe random token, for OAuth `state`, webhook verify tokens and every OAuth credential. */
export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(bytes))))
}

/**
 * SHA-256 as lowercase hex, for a value stored as a fingerprint instead of as itself.
 *
 * Invite tokens go through this: the link is shown once, and a D1 export then hands over
 * hashes rather than working invitations. A plain digest — no salt, no stretching — is
 * right here because the input is 24 random bytes, not something a person chose.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 as base64url — the encoding PKCE's `S256` compares a `code_challenge` in. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToBase64Url(new Uint8Array(digest))
}

/**
 * An HMAC key of its own for one purpose, derived from a secret that already exists.
 *
 * HKDF rather than reusing the secret as the MAC key directly: `SESSION_SECRET` already
 * signs every session cookie, and a MAC the OAuth layer hands out — over a payload a
 * stranger partly chose — must never be one the cookie check would also accept. Deriving
 * under a distinct `info` makes the two keys unrelated without asking a forker to generate
 * and store a fifth secret.
 */
export async function derivedMacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(new ArrayBuffer(0)), info: encoder.encode(purpose) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

/** HMAC-SHA256 of `value` as base64url. Compare two of these with `timingSafeEqual`. */
export async function macBase64Url(key: CryptoKey, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return bytesToBase64Url(new Uint8Array(mac))
}
