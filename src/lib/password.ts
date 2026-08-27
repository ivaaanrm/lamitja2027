import { base64ToBytes, bytesToBase64, timingSafeEqual } from './crypto'

/**
 * Password hashing. PBKDF2-SHA256 is the only KDF WebCrypto hands a Worker, and bcrypt or
 * argon2 would mean carrying a WASM build into a bundle that is otherwise a few tens of
 * KB — not a trade worth making for a handful of accounts on an invite-only app.
 *
 * The iteration count is spent on the login path only, roughly 100 ms of CPU on a request
 * a person made deliberately, which is well inside a Worker's budget.
 *
 * Length rules live in the zod schemas, not here: this module hashes whatever it is given
 * so that the one place that decides what a valid password is stays the one place a route
 * validates against.
 */
export const PBKDF2_ITERATIONS = 210_000 // OWASP 2023 for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16
const KEY_BITS = 256

async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    KEY_BITS,
  )
  return bytesToBase64(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)))
  return { hash: await derive(password, salt), salt: bytesToBase64(salt) }
}

/**
 * An empty stored hash is the "not bootstrapped yet" marker the migration writes on the
 * owner row, and no password derives to an empty string — but the check is explicit
 * rather than incidental, because "this account has no password yet" must never be a way
 * of signing into it.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  if (!hash || !salt) return false
  return timingSafeEqual(await derive(password, base64ToBytes(salt)), hash)
}

/**
 * A fixed hash and salt to verify against when no account matched, so that a login attempt
 * costs the same whether the address exists or not.
 *
 * The value is arbitrary and the result is always discarded — what is being bought is the
 * ~100 ms of PBKDF2, not a comparison. It is written out rather than derived at module
 * load because deriving it would spend those rounds on every cold start of the Worker,
 * including on requests that never touch the login route.
 */
export const DUMMY_HASH = 'BqTUnQAV3vnqNIeeIBc4vLhsA3vgeWiqjqYtwiTIAgw='
export const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA=='
