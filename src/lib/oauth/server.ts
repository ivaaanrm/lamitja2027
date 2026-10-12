import {
  base64ToBytes,
  derivedMacKey,
  randomToken,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
} from '../crypto'
import {
  ClientError,
  clientIdentity,
  clientSecretFor,
  isDocumentClientId,
  isLoopbackRedirect,
  matchRedirectUri,
  registerClient,
  resolveClient,
  verifyRegisteredClient,
  type AuthMethod,
} from './clients'
import type { Grant, GrantStore, NewToken } from './grants'
import {
  ACCESS_TTL_MS,
  AUTHORIZATION_SERVER_PATH,
  CODE_TTL_MS,
  CONSENT_PATH,
  ENDPOINTS,
  MCP_PATH,
  PROTECTED_RESOURCE_PATH,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
  REQUEST_TTL_MS,
  RETIRED_RETENTION_MS,
  SCOPE,
  authorizationServerMetadata,
  protectedResourceMetadata,
  resourceFor,
} from './metadata'
import { openRequest, sealRequest, type AuthorizationRequest } from './request'

/**
 * The authorization server: what lets an athlete add this app to Claude as a custom
 * connector, sign in here, press «Permitir», and have Claude hold a token for *their*
 * block and nobody else's.
 *
 * It is OAuth 2.1 as the MCP authorization spec profiles it, and only that profile:
 *
 *  - **Authorization code with PKCE `S256`, always.** No implicit grant, no password
 *    grant, no `plain` challenge, no client credentials — every token here exists because
 *    an athlete approved it on `/autorizar`.
 *  - **Discovery**: RFC 9728 protected resource metadata (both the path-suffixed and the
 *    root form) and RFC 8414 authorization server metadata, served here; the MCP
 *    endpoint's `401` points at the first.
 *  - **Clients** identify themselves by metadata document or by stateless dynamic
 *    registration — see `clients.ts`. Nothing about a client is stored.
 *  - **Tokens** are opaque random strings stored as `sha256`, bound to the MCP endpoint's
 *    URL (RFC 8707) and checked against it on every call. An access token lasts an hour; the
 *    refresh token behind it rotates on every use, with a short grace for a retry or a
 *    race and the whole connection revoked if it turns up after that (see `oauthTokens` in
 *    the schema for why that needs a table of its own).
 *  - **`iss` on every authorization response** (RFC 9207), success or error.
 *
 * Like `mcp/protocol.ts`, this file reads no binding and no clock of its own: the store,
 * the secret, `fetch` and `now` are handed in, so every branch below is tested in plain
 * Node. `src/worker.ts` is the only caller that knows where they really come from.
 *
 * Why it answers from the worker entry rather than as Astro routes is in `metadata.ts`
 * (`ENDPOINTS`): Astro's CSRF check refuses a form-encoded POST that carries no matching
 * `Origin`, and that is exactly what a token request from Claude's servers is.
 */

export interface OAuthDeps {
  /** `SESSION_SECRET`. Never used as a key directly — see `oauthKey`. */
  secret: string
  store: GrantStore
  /** For fetching client metadata documents. The global `fetch` in production. */
  fetch: typeof fetch
  now?: () => number
  /** `false` turns the caller away unread. Omitted means no limiting, as in `protocol.ts`. */
  withinLimit?: (request: Request) => Promise<boolean>
}

/** The one key every OAuth MAC is made with, derived so it can never sign a session cookie. */
export const oauthKey = (secret: string): Promise<CryptoKey> => {
  if (!secret) throw new Error('SESSION_SECRET is not set')
  return derivedMacKey(secret, 'treximo/oauth/v1')
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Discovery, registration and the token endpoint may be called from a browser — the MCP
 * Inspector does all three from a page on another origin — so they answer CORS. None of
 * them reads a cookie, so a wildcard origin hands a page nothing it could not get with
 * `curl`. The authorization endpoint does not: it is a navigation, never a fetch.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...headers },
  })

/**
 * Public, unchanging-per-deploy documents. Five minutes is what Claude caches them for
 * anyway; saying so lets every other client do the same.
 */
const document = (body: unknown) =>
  json(body, 200, { 'cache-control': 'public, max-age=300' })

/** RFC 6749 §5.2's error shape, which the token, revocation and registration endpoints share. */
const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  json({ error, error_description: description }, status, headers)

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })

/** `uri` with `params` appended to whatever query it already has, skipping nulls. */
export function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri)
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.append(name, value)
  }
  return url.href
}

/**
 * Is `presented` this server's MCP endpoint? RFC 8707 compares URIs, and the MCP spec asks
 * a server to be forgiving about case in the scheme and host and about a trailing slash —
 * `URL` normalises the first, and the second is stripped here.
 */
export function sameResource(presented: string, canonical: string): boolean {
  let url: URL
  try {
    url = new URL(presented)
  } catch {
    return false
  }
  if (url.hash || url.search) return false
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}` === canonical
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Route = 'resource' | 'server' | 'authorize' | 'token' | 'register' | 'revoke'

function routeFor(pathname: string): Route | null {
  switch (pathname) {
    case PROTECTED_RESOURCE_PATH:
    case `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`:
    case `${PROTECTED_RESOURCE_PATH}${MCP_PATH}/`:
      return 'resource'
    case AUTHORIZATION_SERVER_PATH:
      return 'server'
    case ENDPOINTS.authorize:
      return 'authorize'
    case ENDPOINTS.token:
      return 'token'
    case ENDPOINTS.register:
      return 'register'
    case ENDPOINTS.revoke:
      return 'revoke'
    default:
      return null
  }
}

/** Cheap enough to ask on every request before anything is constructed. */
export const isOAuthPath = (pathname: string): boolean => routeFor(pathname) !== null

const METHODS: Record<Route, readonly string[]> = {
  resource: ['GET', 'HEAD'],
  server: ['GET', 'HEAD'],
  authorize: ['GET'],
  token: ['POST'],
  register: ['POST'],
  revoke: ['POST'],
}

/**
 * Answers every OAuth path, or returns `null` for a path that is not one so the caller can
 * hand the request on. The worker entry calls this before Astro sees anything.
 */
export async function handleOAuth(request: Request, deps: OAuthDeps): Promise<Response | null> {
  const url = new URL(request.url)
  const route = routeFor(url.pathname)
  if (!route) return null

  if (request.method === 'OPTIONS' && route !== 'authorize') {
    return new Response(null, { status: 204, headers: CORS })
  }
  if (!METHODS[route].includes(request.method)) {
    return json({ error: 'invalid_request', error_description: `Use ${METHODS[route].join(' or ')}` }, 405, {
      allow: METHODS[route].join(', '),
    })
  }

  const origin = url.origin
  if (route === 'resource') return document(protectedResourceMetadata(origin, url.pathname.endsWith('/')))
  if (route === 'server') return document(authorizationServerMetadata(origin))

  // Everything past discovery costs a MAC, a fetch or a database read, and the limiter is
  // asked first for the reason `ratelimit.ts` gives: a limiter a correct credential could
  // skip throttles nothing but the status code.
  if (deps.withinLimit && !(await deps.withinLimit(request))) {
    return oauthError(429, 'temporarily_unavailable', 'Too many requests. Wait a minute and try again.', {
      'retry-after': '60',
    })
  }

  const now = (deps.now ?? Date.now)()
  const key = await oauthKey(deps.secret)
  switch (route) {
    case 'authorize':
      return authorize(url, deps, key, now)
    case 'token':
      return token(request, deps, key, now)
    case 'register':
      return register(request, key, now)
    case 'revoke':
      return revoke(request, deps, key)
  }
}

// ---------------------------------------------------------------------------
// The authorization endpoint
// ---------------------------------------------------------------------------

/**
 * Validates the request and sends the browser on to the consent screen, sealed.
 *
 * The order of the checks is RFC 6749 §4.1.2.1's and it is a security property, not a
 * style: until the client *and* the redirect URI are both known to be good, nothing may be
 * sent to that URI — an error delivered to an unverified redirect is an open redirector.
 * So those two failures land on `/autorizar` with a message for the person holding the
 * browser, and everything after them goes back to the client as `?error=`.
 */
async function authorize(url: URL, deps: OAuthDeps, key: CryptoKey, now: number): Promise<Response> {
  const origin = url.origin
  const params = url.searchParams
  // Only the code travels in the URL. The exact reason goes to the Worker's log, because
  // anything `/autorizar` printed from its own query string, anybody could write: a link
  // to this domain carrying a sentence of a stranger's choosing, under this app's mark.
  const stop = (error: 'client' | 'redirect', reason: string) => {
    console.warn(`[oauth] authorize refused (${error}): ${reason}`)
    return redirect(withParams(`${origin}${CONSENT_PATH}`, { error }))
  }

  const clientId = params.get('client_id')
  if (!clientId) return stop('client', 'client_id is required')

  let client
  try {
    client = await resolveClient(clientId, key, deps.fetch)
  } catch (cause) {
    if (cause instanceof ClientError) return stop('client', cause.message)
    throw cause
  }

  // A client with exactly one non-loopback redirect URI may leave it out, as RFC 6749
  // allows. A loopback one never: its port is chosen per run, so it has to be stated.
  const asked = params.get('redirect_uri')
  const only = client.redirectUris.length === 1 ? client.redirectUris[0]! : null
  const redirectUri = asked ?? (only && !isLoopbackRedirect(only) ? only : null)
  if (!redirectUri) return stop('redirect', 'redirect_uri is required')
  if (!matchRedirectUri(client.redirectUris, redirectUri)) {
    return stop('redirect', `redirect_uri is not registered for this client: ${redirectUri}`)
  }

  // From here the redirect URI is trusted, and every failure is the client's to read.
  const state = params.get('state')
  const back = (error: string, description: string) =>
    redirect(withParams(redirectUri, { error, error_description: description, state, iss: origin }))

  if (params.get('response_type') !== 'code') {
    return back('unsupported_response_type', 'Only response_type=code is supported')
  }
  const challenge = params.get('code_challenge')
  if (!challenge || params.get('code_challenge_method') !== 'S256') {
    return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return back('invalid_request', 'code_challenge must be the base64url SHA-256 of the code_verifier')
  }
  if (state !== null && state.length > 1024) return back('invalid_request', 'state is too long')

  // RFC 8707. A client that names no resource is an older one, and it can only mean this
  // server — it is the only resource here — so the token is bound to it all the same.
  const resource = resourceFor(origin)
  const named = params.getAll('resource')
  if (named.length > 1 || (named.length === 1 && !sameResource(named[0]!, resource))) {
    return back('invalid_target', `This server only issues tokens for ${resource}`)
  }

  // Unknown scopes are ignored rather than refused — `offline_access`, `openid` — as RFC
  // 6749 §3.3 allows. What is granted is always the one scope, and the token response
  // says so.
  const sealed = await sealRequest(
    {
      clientId: client.id,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: SCOPE,
      resource,
      identity: clientIdentity(client, redirectUri),
      expiresAt: now + REQUEST_TTL_MS,
    },
    key,
  )
  return redirect(withParams(`${origin}${CONSENT_PATH}`, { req: sealed }))
}

// ---------------------------------------------------------------------------
// Consent — called by `/api/oauth/consent` once it knows who the athlete is
// ---------------------------------------------------------------------------

/** The sealed request behind the consent screen, or `null` once it is stale or was forged. */
export async function openConsent(sealed: string, secret: string, now: number) {
  return openRequest(sealed, await oauthKey(secret), now)
}

/**
 * The athlete said yes: mint a code and return where to send the browser with it.
 *
 * The grant row is born here, holding the code's hash and the PKCE challenge — not at the
 * code exchange — because the code has to be redeemable by a client that has never been
 * near this athlete's cookie. `prune` runs first so an athlete who clicks «Conectar» and
 * walks away does not leave a row behind for every time they did.
 */
export async function approveConsent(
  request: AuthorizationRequest,
  userId: string,
  store: GrantStore,
  origin: string,
  now: number,
): Promise<string> {
  await store.prune(userId, now)

  const code = randomToken(32)
  await store.create({
    userId,
    id: crypto.randomUUID(),
    clientId: request.clientId,
    clientName: request.identity.name,
    clientHost: request.identity.host,
    redirectUri: request.redirectUri,
    scope: request.scope,
    resource: request.resource,
    codeHash: await sha256Hex(code),
    codeChallenge: request.codeChallenge,
    codeExpiresAt: now + CODE_TTL_MS,
  })
  return withParams(request.redirectUri, { code, state: request.state, iss: origin })
}

/** The athlete said no. RFC 6749's `access_denied`, so the client can say so too. */
export const denyConsent = (request: AuthorizationRequest, origin: string): string =>
  withParams(request.redirectUri, {
    error: 'access_denied',
    error_description: 'The athlete declined to connect',
    state: request.state,
    iss: origin,
  })

// ---------------------------------------------------------------------------
// Client authentication at the token and revocation endpoints
// ---------------------------------------------------------------------------

/** `Authorization: Basic` as RFC 6749 §2.3.1 encodes it: both halves form-urlencoded first. */
function basicCredentials(header: string | null): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header)) return null
  try {
    const decoded = new TextDecoder().decode(base64ToBytes(header.slice(6).trim()))
    const colon = decoded.indexOf(':')
    if (colon < 0) return null
    const unescape = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '))
    return { id: unescape(decoded.slice(0, colon)), secret: unescape(decoded.slice(colon + 1)) }
  } catch {
    return null
  }
}

/**
 * The form body. RFC 6749 says `application/x-www-form-urlencoded` and Claude sends
 * exactly that; a JSON body is read too, because a client that sends one is wrong in a way
 * that costs nothing to forgive.
 */
async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? ''
  const text = await request.text()
  if (!type.includes('application/json')) return new URLSearchParams(text)

  const form = new URLSearchParams()
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      for (const [name, value] of Object.entries(body)) {
        if (typeof value === 'string') form.append(name, value)
      }
    }
  } catch {
    // An unparseable body is an empty form, and the missing fields say what is wrong.
  }
  return form
}

/**
 * Who the client is, proven to the standard its registration demands — or the `401` to
 * answer with. A public client (every metadata document, and any registration that said
 * `none`) is identified by its `client_id` alone; PKCE is what proves it is the same client
 * that started the flow. A confidential one must present the secret derived for it.
 */
async function authenticateClient(
  request: Request,
  form: URLSearchParams,
  key: CryptoKey,
): Promise<{ clientId: string } | Response> {
  const basic = basicCredentials(request.headers.get('authorization'))
  const bodyId = form.get('client_id')
  if (basic && bodyId !== null && bodyId !== basic.id) {
    return oauthError(400, 'invalid_request', 'client_id in the body and in Authorization differ')
  }

  const clientId = basic?.id ?? bodyId
  const secret = basic?.secret ?? form.get('client_secret')
  const refuse = (description: string) =>
    oauthError(401, 'invalid_client', description, basic ? { 'www-authenticate': 'Basic realm="oauth"' } : {})

  if (!clientId) return refuse('client_id is required')

  let method: AuthMethod
  if (isDocumentClientId(clientId)) {
    method = 'none'
  } else {
    const registered = await verifyRegisteredClient(clientId, key)
    if (!registered) return refuse('Unknown client_id')
    method = registered.authMethod
  }

  if (method !== 'none') {
    const expected = await clientSecretFor(clientId, key)
    if (!secret || !timingSafeEqual(secret, expected)) return refuse('Client authentication failed')
  }
  return { clientId }
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

/**
 * A fresh pair: the plaintexts for the response, their hashes for the store. `parent` is
 * the refresh token this one replaces, which is what makes its siblings findable.
 */
async function mintPair(now: number, parent: string | null) {
  const access = randomToken(32)
  const refresh = randomToken(32)
  const tokens: NewToken[] = [
    { hash: await sha256Hex(access), kind: 'access', parentHash: null, expiresAt: now + ACCESS_TTL_MS },
    { hash: await sha256Hex(refresh), kind: 'refresh', parentHash: parent, expiresAt: now + REFRESH_TTL_MS },
  ]
  return { access, refresh, tokens }
}

const issued = (access: string, refresh: string, scope: string) =>
  json(
    {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope,
    },
    200,
    { pragma: 'no-cache' },
  )

/**
 * Every refusal of a code or a refresh token is `invalid_grant`, with the reason in the
 * description. Claude's documentation is specific that a dead refresh token must come back
 * as `invalid_grant` and nothing else, because that is the code it re-authorizes on.
 */
const badGrant = (description: string) => oauthError(400, 'invalid_grant', description)

/** A `resource` on a token request must name the one the grant was bound to, if it names any. */
function wrongResource(form: URLSearchParams, grant: Grant): Response | null {
  const named = form.getAll('resource')
  if (named.length === 0) return null
  if (named.length === 1 && sameResource(named[0]!, grant.resource)) return null
  return oauthError(400, 'invalid_target', `This grant is for ${grant.resource}`)
}

async function token(request: Request, deps: OAuthDeps, key: CryptoKey, now: number): Promise<Response> {
  const form = await readForm(request)
  const client = await authenticateClient(request, form, key)
  if (client instanceof Response) return client

  const grantType = form.get('grant_type')
  if (grantType === 'authorization_code') return exchangeCode(form, client.clientId, deps.store, now)
  if (grantType === 'refresh_token') return refreshGrant(form, client.clientId, deps.store, now)
  return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
}

async function exchangeCode(
  form: URLSearchParams,
  clientId: string,
  store: GrantStore,
  now: number,
): Promise<Response> {
  const code = form.get('code')
  const verifier = form.get('code_verifier')
  if (!code) return oauthError(400, 'invalid_request', 'code is required')
  if (!verifier) return oauthError(400, 'invalid_request', 'code_verifier is required (PKCE)')

  const grant = await store.findByCode(await sha256Hex(code))
  if (!grant) return badGrant('Unknown authorization code')
  if (grant.clientId !== clientId) return badGrant('The authorization code was issued to another client')

  // OAuth 2.1 §4.1.3: a code presented twice means someone else holds a copy, and whatever
  // it already opened should not outlive the discovery.
  const replayed = async () => {
    await store.revoke(grant.userId, grant.id)
    return badGrant('This authorization code was already used; the connection it opened has been revoked')
  }
  if (grant.codeUsedAt !== null) return replayed()
  if (grant.codeExpiresAt <= now) return badGrant('The authorization code has expired')

  const redirectUri = form.get('redirect_uri')
  if (redirectUri !== null && redirectUri !== grant.redirectUri) {
    return badGrant('redirect_uri does not match the authorization request')
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return badGrant('code_verifier must be 43–128 characters of [A-Za-z0-9._~-]')
  }
  if (!timingSafeEqual(await sha256Base64Url(verifier), grant.codeChallenge)) {
    return badGrant('PKCE verification failed')
  }
  const target = wrongResource(form, grant)
  if (target) return target

  // Two exchanges of one code in flight at once: the loser is a replay like any other.
  if (!(await store.redeem(grant, now))) return replayed()
  const { access, refresh, tokens } = await mintPair(now, null)
  if (!(await store.issue(grant, tokens, now))) return badGrant('The connection has been revoked')
  return issued(access, refresh, grant.scope)
}

async function refreshGrant(
  form: URLSearchParams,
  clientId: string,
  store: GrantStore,
  now: number,
): Promise<Response> {
  const presented = form.get('refresh_token')
  if (!presented) return oauthError(400, 'invalid_request', 'refresh_token is required')

  const found = await store.findToken(await sha256Hex(presented), 'refresh')
  if (!found || found.token.expiresAt <= now) return badGrant('The refresh token is invalid or has expired')
  const { token, grant } = found
  if (grant.clientId !== clientId) return badGrant('The refresh token was issued to another client')
  const target = wrongResource(form, grant)
  if (target) return target

  // A refresh may narrow the scope, never widen it. With one scope there is nothing to
  // narrow to, so this only ever refuses a request for something that was never granted.
  const asked = form.get('scope')
  const granted = new Set(grant.scope.split(' '))
  if (asked && asked.split(' ').some((scope) => scope && !granted.has(scope))) {
    return oauthError(400, 'invalid_scope', `Only ${grant.scope} was granted`)
  }

  const stolen = async () => {
    await store.revoke(grant.userId, grant.id)
    return badGrant('This refresh token was already used; the connection has been revoked')
  }

  // Live: claim it. Losing the claim means another request retired it between our read and
  // now — so it is read again and judged as the retired token it has become, never waved
  // through on the assumption that whoever won was a harmless twin.
  let current = token
  if (current.retiredAt === null && !(await store.retire(current, now, now + RETIRED_RETENTION_MS))) {
    const reread = await store.findToken(current.hash, 'refresh')
    if (!reread) return badGrant('The refresh token is no longer valid')
    current = reread.token
  }

  // Already used. Within the grace window, and while the client has not yet used what it
  // was given for it, this is a lost answer or a race and is honoured with a pair of its
  // own. Any later, or once its successor has been used, it is a copy in somebody else's
  // hands — and since there is no telling which holder is the athlete's client, the whole
  // connection goes, the copy's tokens with it.
  const grace = current !== token || token.retiredAt !== null
  if (grace && (now - current.retiredAt! > REFRESH_GRACE_MS || (await store.successorUsed(current)))) {
    return stolen()
  }

  const { access, refresh, tokens } = await mintPair(now, current.hash)
  if (!(await store.issue(grant, tokens, now))) return badGrant('The connection has been revoked')

  // The check above and the insert are two steps. If a successor was used in between, the
  // pair just minted is a sibling that sibling-retirement ran too early to see — a second
  // chain nobody would ever notice. Looking again after the insert closes that gap.
  if (grace && (await store.successorUsed(current))) return stolen()
  return issued(access, refresh, grant.scope)
}

// ---------------------------------------------------------------------------
// Registration and revocation
// ---------------------------------------------------------------------------

async function register(request: Request, key: CryptoKey, now: number): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'The registration request must be a JSON object')
  }
  try {
    return json(await registerClient(body, key, now), 201)
  } catch (cause) {
    if (cause instanceof ClientError) return oauthError(400, cause.code, cause.message)
    throw cause
  }
}

/**
 * RFC 7009. Either token of a pair revokes the whole connection, which is what a client
 * that calls this means. An unknown token is a `200`: the RFC says so, because "it is
 * already gone" is the outcome the client asked for.
 */
async function revoke(request: Request, deps: OAuthDeps, key: CryptoKey): Promise<Response> {
  const form = await readForm(request)
  const client = await authenticateClient(request, form, key)
  if (client instanceof Response) return client

  const presented = form.get('token')
  if (!presented) return oauthError(400, 'invalid_request', 'token is required')

  const hash = await sha256Hex(presented)
  const found = (await deps.store.findToken(hash, 'access')) ?? (await deps.store.findToken(hash, 'refresh'))
  if (!found) return new Response(null, { status: 200, headers: CORS })
  const { grant } = found
  if (grant.clientId !== client.clientId) {
    return oauthError(400, 'unauthorized_client', 'The token was issued to another client')
  }

  await deps.store.revoke(grant.userId, grant.id)
  return new Response(null, { status: 200, headers: CORS })
}

// ---------------------------------------------------------------------------
// The resource server's half
// ---------------------------------------------------------------------------

/**
 * Whose access token this is, or `null`. Checked on every MCP request: the token must be
 * live, and it must have been issued *for this endpoint* — RFC 8707's audience check, which
 * is what stops a token minted for one deployment being replayed at another that shares a
 * database, and what the MCP spec means by "MUST validate tokens were issued for them".
 */
export async function resolveAccessToken(
  store: GrantStore,
  presented: string,
  resource: string,
  now: number,
): Promise<string | null> {
  const found = await store.findToken(await sha256Hex(presented), 'access')
  if (!found || found.token.expiresAt <= now) return null
  return sameResource(found.grant.resource, resource) ? found.grant.userId : null
}
