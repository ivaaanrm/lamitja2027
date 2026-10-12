import { APP_NAME } from '../config'

/**
 * Where everything OAuth lives, how long each credential lasts, and the two discovery
 * documents a client reads before it can ask for anything.
 *
 * Every URL here is built from the request's own origin rather than from `astro.config`'s
 * `site` or a var: the same Worker answers on `workers.dev`, on a custom domain and on
 * `localhost`, and a token issued on one of them must name that one. The resource a token
 * is bound to is therefore whichever address the client actually connected to — which is
 * exactly what RFC 8707 asks for, and why a deployment that moves host makes every
 * connection re-authorize rather than quietly accepting tokens minted for its old name.
 *
 * Pure: no bindings, no clock. The worker entry and the MCP route both read these, and the
 * tests read them too, so a path changed here cannot leave one of the three behind.
 */

/** The MCP endpoint — the one *protected resource* this authorization server issues for. */
export const MCP_PATH = '/api/mcp'

/**
 * The one scope, and the whole of it: read the athlete's block and write their plan.
 *
 * One rather than a read/write pair on purpose. Claude lets the athlete gate each tool
 * itself — always allow, ask, never — and every tool carries `readOnlyHint` for exactly
 * that; a second scope would be a second, coarser copy of the same switch, and the step-up
 * dance it implies is a consent screen in the middle of writing a plan.
 */
export const SCOPE = 'mcp'

/**
 * The protocol endpoints. Outside `/api/` deliberately: they are answered by the worker
 * entry before Astro runs (`src/worker.ts`), so they never meet the session-cookie gate in
 * `middleware.ts` — and the token endpoint *cannot* run behind Astro, whose CSRF check
 * refuses a form-encoded POST with no matching `Origin`, which is precisely what an OAuth
 * client's server sends. A different prefix makes "this never passes the gate" visible in
 * the URL rather than in a list somebody has to remember.
 */
export const ENDPOINTS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
} as const

/** The consent screen — a prerendered page like every other, see `src/pages/autorizar.astro`. */
export const CONSENT_PATH = '/autorizar'

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** How long a validated request may wait on the consent screen — long enough to sign in first. */
export const REQUEST_TTL_MS = 10 * MINUTE_MS
/** A code is exchanged by the client's server the instant the browser lands; five minutes is slack. */
export const CODE_TTL_MS = 5 * MINUTE_MS
/** An hour: short enough that a leaked access token is a small window, long enough not to churn. */
export const ACCESS_TTL_MS = 60 * MINUTE_MS
/**
 * Sixty days *idle*. Every refresh issues a new refresh token with a fresh sixty days, so a
 * connection in weekly use never lapses, and one abandoned for two months has to be
 * re-approved.
 */
export const REFRESH_TTL_MS = 60 * DAY_MS
/**
 * How long a refresh token that has just been used may still be presented, for the two
 * honest reasons to present one twice: the response carrying its successor was lost, or
 * two refreshes raced. Presented later than this, it is a copy, and the connection is
 * revoked.
 *
 * Ten minutes rather than the one most providers allow, because the clock is the *weak*
 * signal here. Claude waits up to thirty seconds on a refresh and refreshes up to five
 * minutes early, so a lost answer may not be retried for minutes, and revoking an honest
 * connection costs the athlete a trip back to `/autorizar`. The strong signal is
 * `successorUsed`: a token presented after the client has already used what it was given
 * for it is a copy however soon it arrives, and that check applies inside the window too.
 */
export const REFRESH_GRACE_MS = 10 * 60_000
/** How long a retired refresh token is kept, only so that presenting it can be noticed. */
export const RETIRED_RETENTION_MS = 7 * DAY_MS

/** The canonical URI of the MCP server at this origin — the `resource` a token is bound to. */
export const resourceFor = (origin: string): string => `${origin}${MCP_PATH}`

/**
 * RFC 9728's path-suffixed metadata URL. Clients try this form first when the resource has
 * a path, and it is what the `401` challenge points at — so it is the one that must work.
 *
 * `slash` is for the athlete who pasted `…/api/mcp/`. Claude insists the document's
 * `resource` equal the URL *as entered*, character for character, so that address gets a
 * document of its own naming it with the slash. Tokens do not care: `sameResource` reads
 * the two as one.
 */
export const resourceMetadataUrl = (origin: string, slash = false): string =>
  `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}${slash ? '/' : ''}`

/** RFC 9728 — which authorization server to ask, and for what. */
export function protectedResourceMetadata(origin: string, slash = false) {
  return {
    resource: `${resourceFor(origin)}${slash ? '/' : ''}`,
    // Claude uses the first entry and only the first, so there is exactly one.
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: APP_NAME,
  }
}

/**
 * RFC 8414 — what this authorization server can do.
 *
 * Two fields are load-bearing for Claude in a way the RFC does not make obvious. Claude
 * identifies itself with a Client ID Metadata Document only when *both*
 * `client_id_metadata_document_supported` is true *and* `none` is a token endpoint auth
 * method, because its document describes a public client; with either missing it falls
 * back to Dynamic Client Registration. And `code_challenge_methods_supported` must be
 * present at all, or a spec-compliant client refuses to start the flow.
 *
 * `offline_access` is deliberately absent from `scopes_supported`. Refresh tokens are
 * issued to every client regardless, and listing it would make Claude append it to every
 * request for a consent screen to explain.
 */
export function authorizationServerMetadata(origin: string) {
  const authMethods = ['none', 'client_secret_post', 'client_secret_basic']
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${ENDPOINTS.authorize}`,
    token_endpoint: `${origin}${ENDPOINTS.token}`,
    registration_endpoint: `${origin}${ENDPOINTS.register}`,
    revocation_endpoint: `${origin}${ENDPOINTS.revoke}`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: authMethods,
    revocation_endpoint_auth_methods_supported: authMethods,
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    // RFC 9207: every authorization response carries `iss`, so a client talking to more
    // than one authorization server can tell which one answered.
    authorization_response_iss_parameter_supported: true,
    ui_locales_supported: ['es'],
  }
}

/**
 * The `WWW-Authenticate` value on every `401` from the MCP endpoint.
 *
 * This header is the whole of discovery as far as Claude is concerned: it starts sign-in
 * only on a `401` that carries one, and reads `resource_metadata` to find out where to go.
 * `error="invalid_token"` is added only when a token was actually presented — RFC 6750 §3.1
 * says a request with no credentials at all gets the bare challenge — and it is what tells
 * a client holding an expired access token to refresh it rather than start over.
 */
export function bearerChallenge(origin: string, error?: 'invalid_token', slash = false): string {
  const params = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataUrl(origin, slash)}"`,
    `scope="${SCOPE}"`,
  ]
  return `Bearer ${params.join(', ')}`
}
