import { base64UrlToBytes, bytesToBase64Url, macBase64Url, timingSafeEqual } from '../crypto'
import { MAC_LABEL, type ClientIdentity } from './clients'

/**
 * A validated authorization request, carried across the consent screen in the URL rather
 * than in a table.
 *
 * `/oauth/authorize` does every check that does not need to know who the athlete is — the
 * client is real, the redirect URI is one of its own, PKCE is S256, the resource is this
 * server — and then has nothing to do but wait for a person to sign in and press a button,
 * which may take minutes. Storing the request for that long would be a row per click on
 * «Conectar», written by an unauthenticated endpoint. Signing it instead means the consent
 * screen and the decision it posts back can only ever carry a request this server already
 * validated, unchanged, and only for `REQUEST_TTL_MS`.
 *
 * It is signed and not encrypted: nothing in it is a secret. The `state` and the PKCE
 * challenge are both designed to travel through the browser in the clear.
 */
export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  scope: string
  resource: string
  /** What the consent screen shows — worked out once, when the client was resolved. */
  identity: ClientIdentity
  expiresAt: number
}

export async function sealRequest(request: AuthorizationRequest, key: CryptoKey): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(request)) as Uint8Array<ArrayBuffer>,
  )
  return `${payload}.${await macBase64Url(key, MAC_LABEL.request + payload)}`
}

/** The request a seal carries, or `null` when it is forged, mangled or stale. */
export async function openRequest(
  sealed: string,
  key: CryptoKey,
  now: number,
): Promise<AuthorizationRequest | null> {
  const dot = sealed.lastIndexOf('.')
  if (dot < 1) return null

  const payload = sealed.slice(0, dot)
  if (!timingSafeEqual(sealed.slice(dot + 1), await macBase64Url(key, MAC_LABEL.request + payload))) {
    return null
  }

  let request: AuthorizationRequest
  try {
    request = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as AuthorizationRequest
  } catch {
    return null
  }
  return request.expiresAt > now ? request : null
}
