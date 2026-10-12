import { base64UrlToBytes, bytesToBase64Url, macBase64Url, timingSafeEqual } from '../crypto'

/**
 * Who is asking — the two ways an OAuth client can introduce itself here, and neither of
 * them writes a row.
 *
 * **A metadata document** (CIMD, draft-ietf-oauth-client-id-metadata-document) is how
 * Claude arrives: its `client_id` *is* an `https` URL, and the JSON served there lists its
 * name and redirect URIs. The document's host is what vouches for it — whoever controls
 * `claude.ai` controls that `client_id` — so it is the host, not the self-declared name,
 * that the consent screen leads with. It is fetched at authorization time and nowhere else:
 * the code exchange and every refresh only check that the `client_id` presented is the one
 * the grant was issued to, so a slow or briefly unreachable document can never break a
 * connection that already exists.
 *
 * **A dynamic registration** (RFC 7591) is how most other MCP clients arrive, and the spec
 * now keeps it only for backwards compatibility. It is *stateless* here: the `client_id`
 * this server hands back is the registration itself — redirect URIs, name, auth method —
 * signed, so `/oauth/authorize` can read the redirect URIs straight out of the id and
 * trust them. That is a deliberate answer to DCR's known failure, an unauthenticated
 * endpoint that grows a table by one row per connection: here it grows nothing, so there
 * is nothing to rate-limit for space and nothing to garbage-collect. A confidential client's
 * secret is derived the same way, as a MAC over its own id.
 *
 * What this costs is revocation *of a client*: a signed id cannot be un-signed. Nothing
 * needs that. Access is revoked per athlete per connection — a grant — and a registration
 * on its own can do nothing until an athlete approves it.
 */

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'
const AUTH_METHODS: readonly AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic']

export interface OAuthClient {
  id: string
  /** What the client calls itself. Self-asserted either way, so never the headline on its own. */
  name: string | null
  redirectUris: string[]
  authMethod: AuthMethod
  /** `document`: the `client_id` URL's host vouches for it. `registered`: nothing does. */
  kind: 'document' | 'registered'
}

/**
 * A client this server will not deal with, worded for the developer who wrote it. The
 * code is RFC 7591's or RFC 6749's, so the endpoint can answer with it unchanged.
 */
export class ClientError extends Error {
  constructor(
    readonly code: 'invalid_client' | 'invalid_client_metadata' | 'invalid_redirect_uri',
    message: string,
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

/** The prefix a signed registration carries, so one can never be mistaken for a URL. */
const REGISTERED_PREFIX = 'dcr.'
/** Room for a handful of redirect URIs and a name; anything bigger is not a real client. */
const MAX_REGISTRATION_BYTES = 2048
const MAX_REDIRECT_URIS = 5
const MAX_URI_LENGTH = 512
const MAX_NAME_LENGTH = 100
/** The draft recommends 5 KB; Claude's own document is under 400 bytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024
const DOCUMENT_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Schemes a redirect may never use, whatever the client claims. Everything else that is
 * not `http`/`https` is a native app's private-use scheme (RFC 8252 §7.1) — `cursor://`,
 * `vscode://` — and the operating system routes it to the app that registered it.
 */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])

const parse = (value: string): URL | null => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** `http://localhost…`, `http://127.0.0.1…` or `http://[::1]…` — a native app's own listener. */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri)
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Whether a client may register this redirect URI at all.
 *
 * `https` anywhere; plain `http` only on loopback, where there is no network to intercept
 * it on; a private-use scheme for a native app. Never a fragment — the code is delivered in
 * the query and a fragment is where an attacker's script would read it — and never
 * credentials in the authority.
 */
export function validRedirectUri(uri: string): boolean {
  // Whitespace and control characters first, and outright: `URL` silently strips a tab or
  // a newline, so a check on what was *sent* and a redirect built from what was *parsed*
  // could disagree about the same string.
  if (uri.length > MAX_URI_LENGTH || uri.includes('#') || /[\s\x00-\x1f\x7f]/.test(uri)) return false
  const url = parse(uri)
  if (!url || url.username || url.password) return false
  if (url.protocol === 'https:') return url.hostname !== ''
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || FORBIDDEN_SCHEMES.has(url.protocol)) return false
  // A scheme that *carries* a URL — `microsoft-edge:https://evil.example/cb` opens that
  // address in a browser, and so do `…:https:evil.example` and `…:https:\\evil.example` — is
  // a redirect to somewhere the consent screen cannot name. A native app's own scheme
  // points at the app, so nothing after it may look like another scheme: no colon at all
  // in the parsed remainder, which is also what the redirect is built from.
  return !url.href.slice(url.protocol.length).includes(':')
}

/**
 * Is `requested` one of `registered`? Exact string comparison — OAuth 2.1 removed every
 * kind of fuzzy matching — with the one exception it keeps: a loopback redirect matches
 * whatever port it arrives on (RFC 8252 §7.3), because a native app binds an ephemeral
 * port per run and cannot know it when it registers.
 *
 * Claude Code's document lists both `http://localhost/callback` and
 * `http://127.0.0.1/callback` and connects on a fresh port every session, so `localhost`
 * gets the same port-blind match — which RFC 8252 §8.3 discourages and Claude's own
 * documentation asks for. The host and path must still match exactly; only the port is
 * free.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  if (!isLoopbackRedirect(requested)) return false

  const want = parse(requested)!
  return registered.some((candidate) => {
    if (!isLoopbackRedirect(candidate)) return false
    const have = parse(candidate)!
    return (
      have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search
    )
  })
}

// ---------------------------------------------------------------------------
// Metadata documents
// ---------------------------------------------------------------------------

/** A `client_id` that names a document rather than a registration. */
export const isDocumentClientId = (clientId: string): boolean => clientId.startsWith('https://')

/**
 * The draft's rules for a `client_id` URL, plus one of ours: the host must be a real DNS
 * name. A Worker cannot reach a private network, but `wrangler dev` on a laptop can, and an
 * authorization server that fetches whatever URL a stranger types is a request-forgery tool
 * aimed at the machine it runs on.
 */
function documentUrl(clientId: string): URL {
  const url = parse(clientId)
  const fail = (why: string) =>
    new ClientError('invalid_client', `client_id is not a valid metadata document URL: ${why}`)

  if (!url || url.protocol !== 'https:') throw fail('it must be an https URL')
  if (url.username || url.password) throw fail('it must not carry credentials')
  if (clientId.includes('#')) throw fail('it must not have a fragment')
  if (url.pathname === '/' || url.pathname === '') throw fail('it must have a path')
  // `URL` resolves dot segments away, so they are looked for in what was actually sent.
  if (/\/\.\.?(?:\/|$|\?)/.test(clientId)) throw fail('it must not contain dot segments')

  const host = url.hostname
  const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
  if (ipLiteral || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    throw fail('its host must be a public DNS name')
  }
  return url
}

/** The body, or a `ClientError` past `limit` bytes — never the whole of an endless stream. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new ClientError('invalid_client', 'The client metadata document is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const cleanName = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_NAME_LENGTH) : null

/**
 * Fetches and validates a client's metadata document.
 *
 * No redirects are followed — the document must live at the URL that *is* the client's
 * identity, or the identity means nothing — and the read is capped in both time and size.
 * The document may only describe a public client: the draft forbids a shared secret here,
 * since anyone can read the document, and Claude's says `none`.
 */
export async function fetchClientDocument(
  clientId: string,
  fetcher: typeof fetch,
): Promise<OAuthClient> {
  const url = documentUrl(clientId)

  let response: Response
  try {
    response = await fetcher(url.href, {
      // A Worker's subrequest carries no User-Agent of its own, and bot protection in front
      // of a client's host is entitled to refuse an anonymous one. Say what is asking.
      headers: { accept: 'application/json', 'user-agent': 'Treximo-OAuth/1 (client-id-metadata-document)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    })
  } catch {
    throw new ClientError('invalid_client', `Could not fetch the client metadata document at ${clientId}`)
  }
  if (response.status !== 200) {
    throw new ClientError(
      'invalid_client',
      `The client metadata document at ${clientId} answered ${response.status}`,
    )
  }

  let doc: unknown
  try {
    doc = JSON.parse(await readCapped(response, MAX_DOCUMENT_BYTES))
  } catch (cause) {
    if (cause instanceof ClientError) throw cause
    throw new ClientError('invalid_client', 'The client metadata document is not JSON')
  }

  if (!isRecord(doc)) throw new ClientError('invalid_client', 'The client metadata document is not an object')
  if (doc.client_id !== clientId) {
    throw new ClientError('invalid_client', 'The document’s client_id does not match the URL it was served from')
  }
  const redirectUris = doc.redirect_uris
  if (!isStringArray(redirectUris) || redirectUris.length === 0) {
    throw new ClientError('invalid_client', 'The client metadata document lists no redirect_uris')
  }
  if (!redirectUris.every(validRedirectUri)) {
    throw new ClientError('invalid_client', 'The client metadata document lists a redirect URI this server will not use')
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new ClientError('invalid_client', 'A metadata document may only describe a public client (token_endpoint_auth_method "none")')
  }
  if (doc.grant_types !== undefined && !(isStringArray(doc.grant_types) && doc.grant_types.includes('authorization_code'))) {
    throw new ClientError('invalid_client', 'The client does not use the authorization_code grant')
  }

  return {
    id: clientId,
    name: cleanName(doc.client_name),
    redirectUris,
    authMethod: 'none',
    kind: 'document',
  }
}

// ---------------------------------------------------------------------------
// Dynamic registration, signed rather than stored
// ---------------------------------------------------------------------------

/** What a signed `client_id` carries. Short keys: this travels in every authorization URL. */
interface Registration {
  /** client_name */
  n?: string
  /** redirect_uris */
  r: string[]
  /** token_endpoint_auth_method */
  m: AuthMethod
  /** issued at, epoch seconds */
  t: number
}

const encodeJson = (value: unknown): string =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>)

/**
 * The MAC labels. Every MAC this module and `request.ts` issue comes from one derived key,
 * and the label in front of the payload is what stops one kind being replayed as another —
 * a registration's MAC is not a valid client secret, and neither opens a consent request.
 */
export const MAC_LABEL = { client: 'client:', secret: 'secret:', request: 'request:' } as const

/**
 * Registers a client from an RFC 7591 request body, or throws a `ClientError` naming the
 * field at fault. Returns the response body RFC 7591 §3.2.1 prescribes.
 *
 * An omitted `token_endpoint_auth_method` means `client_secret_basic`, as the RFC says it
 * does — a client that wants to be public says `none`, and the MCP SDKs all do.
 */
export async function registerClient(body: unknown, key: CryptoKey, now: number) {
  if (!isRecord(body)) throw new ClientError('invalid_client_metadata', 'Expected a JSON object')

  const redirectUris = body.redirect_uris
  if (!isStringArray(redirectUris) || redirectUris.length === 0) {
    throw new ClientError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings')
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw new ClientError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris`)
  }
  const bad = redirectUris.find((uri) => !validRedirectUri(uri))
  if (bad !== undefined) {
    throw new ClientError(
      'invalid_redirect_uri',
      `Redirect URI not allowed: ${bad} — use https, a loopback http address, or an app’s private-use scheme, with no fragment`,
    )
  }

  const grantTypes = body.grant_types ?? ['authorization_code']
  if (
    !isStringArray(grantTypes) ||
    !grantTypes.includes('authorization_code') ||
    grantTypes.some((type) => type !== 'authorization_code' && type !== 'refresh_token')
  ) {
    throw new ClientError('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token')
  }
  const responseTypes = body.response_types ?? ['code']
  if (!isStringArray(responseTypes) || responseTypes.some((type) => type !== 'code')) {
    throw new ClientError('invalid_client_metadata', 'response_types may only be code')
  }

  const method = body.token_endpoint_auth_method ?? 'client_secret_basic'
  if (typeof method !== 'string' || !(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new ClientError(
      'invalid_client_metadata',
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`,
    )
  }

  const name = cleanName(body.client_name)
  const issuedAt = Math.floor(now / 1000)
  const registration: Registration = {
    ...(name ? { n: name } : {}),
    r: redirectUris,
    m: method as AuthMethod,
    t: issuedAt,
  }
  const payload = encodeJson(registration)
  if (payload.length > MAX_REGISTRATION_BYTES) {
    throw new ClientError('invalid_client_metadata', 'The registration is too large')
  }
  const clientId = `${REGISTERED_PREFIX}${payload}.${await macBase64Url(key, MAC_LABEL.client + payload)}`

  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    ...(name ? { client_name: name } : {}),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(method === 'none'
      ? {}
      : { client_secret: await clientSecretFor(clientId, key), client_secret_expires_at: 0 }),
  }
}

/** A confidential client's secret: a MAC over its own id, so it is never stored either. */
export const clientSecretFor = (clientId: string, key: CryptoKey): Promise<string> =>
  macBase64Url(key, MAC_LABEL.secret + clientId)

/** The client a signed `client_id` describes, or `null` if this server never signed it. */
export async function verifyRegisteredClient(clientId: string, key: CryptoKey): Promise<OAuthClient | null> {
  if (!clientId.startsWith(REGISTERED_PREFIX)) return null
  const body = clientId.slice(REGISTERED_PREFIX.length)
  const dot = body.lastIndexOf('.')
  if (dot < 1) return null

  const payload = body.slice(0, dot)
  if (!timingSafeEqual(body.slice(dot + 1), await macBase64Url(key, MAC_LABEL.client + payload))) {
    return null
  }

  let registration: Registration
  try {
    registration = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Registration
  } catch {
    return null
  }
  return {
    id: clientId,
    name: registration.n ?? null,
    redirectUris: registration.r,
    authMethod: registration.m,
    kind: 'registered',
  }
}

/**
 * Any `client_id` to the client it names, fetching a document when it is one. Throws a
 * `ClientError` for an id this server cannot vouch for, with the reason, because the
 * person reading it is the developer of the client.
 */
export async function resolveClient(
  clientId: string,
  key: CryptoKey,
  fetcher: typeof fetch,
): Promise<OAuthClient> {
  if (isDocumentClientId(clientId)) return fetchClientDocument(clientId, fetcher)
  const registered = await verifyRegisteredClient(clientId, key)
  if (registered) return registered
  throw new ClientError(
    'invalid_client',
    'Unknown client_id. Register at the registration_endpoint, or use an https URL serving a client metadata document.',
  )
}

/**
 * Who the consent screen says is asking, and where the athlete will be sent back to.
 *
 * For a document client the headline is the host its `client_id` lives on, because that is
 * the one fact that was verified; its `client_name` is shown beside it as what it calls
 * itself. A registered client has no such anchor, so the redirect URI's host is the best
 * available fact and the screen says the name could not be checked.
 */
export function clientIdentity(client: OAuthClient, redirectUri: string) {
  const redirect = parse(redirectUri)!
  // A web redirect is named by its host; an app's own scheme by the scheme as well, since
  // `cursor://anysphere.cursor-retrieval` and a website with that host are not the same
  // destination and the screen should not make them look like one.
  const web = redirect.protocol === 'https:' || redirect.protocol === 'http:'
  const redirectHost = web
    ? redirect.host
    : `${redirect.protocol}${redirect.host ? `//${redirect.host}` : ''}`
  const host = client.kind === 'document' ? new URL(client.id).host : redirectHost
  return {
    name: client.name ?? host,
    host,
    redirectHost,
    verified: client.kind === 'document',
    loopback: isLoopbackRedirect(redirectUri),
  }
}

export type ClientIdentity = ReturnType<typeof clientIdentity>
