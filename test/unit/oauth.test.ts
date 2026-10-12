import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { randomToken, sha256Base64Url } from '@/lib/crypto'
import {
  clientIdentity,
  fetchClientDocument,
  isLoopbackRedirect,
  matchRedirectUri,
  registerClient,
  validRedirectUri,
  verifyRegisteredClient,
} from '@/lib/oauth/clients'
import type { Grant, GrantStore, NewGrant, Token } from '@/lib/oauth/grants'
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
  REQUEST_TTL_MS,
  RETIRED_RETENTION_MS,
  authorizationServerMetadata,
  bearerChallenge,
  protectedResourceMetadata,
  resourceFor,
} from '@/lib/oauth/metadata'
import { openRequest, sealRequest } from '@/lib/oauth/request'
import {
  approveConsent,
  denyConsent,
  handleOAuth,
  isOAuthPath,
  oauthKey,
  openConsent,
  resolveAccessToken,
  sameResource,
  type OAuthDeps,
} from '@/lib/oauth/server'

/**
 * The authorization server, end to end, in plain Node.
 *
 * Every request below is a fabricated `Request` handed to `handleOAuth` exactly as the
 * worker entry hands it the real one, and the grant table is an in-memory `GrantStore`
 * that honours the same two atomic conditions the D1 one writes in SQL — a code is redeemed
 * once, and a refresh token rotates only while it is one of the two live ones. What this
 * cannot check is that SQL itself; the D1 store is exercised against `pnpm preview`, and
 * its writes are held to the tenancy rule by the scan at the bottom of this file.
 */

const ORIGIN = 'https://treximo.example'
const RESOURCE = resourceFor(ORIGIN)
const SECRET = 'a-session-secret-that-is-long-enough'
const T0 = Date.UTC(2026, 9, 12, 9, 0)

/** Claude Code's real metadata document, byte for byte as claude.ai serves it. */
const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata'
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

/** A hosted-Claude-shaped document: one fixed https callback. */
const HOSTED_ID = 'https://connectors.example/oauth/client-metadata'
const HOSTED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const HOSTED_DOC = {
  client_id: HOSTED_ID,
  client_name: 'Claude',
  redirect_uris: [HOSTED_CALLBACK],
  token_endpoint_auth_method: 'none',
}

/** A `fetch` that serves the two documents above and nothing else, and counts its calls. */
function documents(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (overrides[url]) return overrides[url]()
    if (url === CLAUDE_CODE_ID) return Response.json(CLAUDE_CODE_DOC)
    if (url === HOSTED_ID) return Response.json(HOSTED_DOC)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetcher, calls }
}

/**
 * The two tables, in memory, with the D1 store's semantics. The conditional writes are the
 * ones that matter: `redeem` only while `codeUsedAt` is null, `retire` only while the token
 * is live — and lookups hand back copies, as a database row would be, so the server can
 * never be passing by reference something a later write quietly changes.
 */
function memoryStore() {
  const grants = new Map<string, Grant>()
  const tokens = new Map<string, Token>()
  const key = (userId: string, id: string) => `${userId}/${id}`
  const ofGrant = (userId: string, grantId: string) =>
    [...tokens.values()].filter((token) => token.userId === userId && token.grantId === grantId)
  const live = (grant: Grant, now: number) =>
    ofGrant(grant.userId, grant.id).some(
      (token) => token.kind === 'refresh' && token.retiredAt === null && token.expiresAt > now,
    )

  const store: GrantStore = {
    async create(grant: NewGrant) {
      grants.set(key(grant.userId, grant.id), { codeUsedAt: null, createdAt: T0, lastUsedAt: null, ...grant } as Grant)
    },
    async findByCode(hash) {
      const grant = [...grants.values()].find((row) => row.codeHash === hash)
      return grant ? { ...grant } : null
    },
    async redeem(grant, now) {
      const row = grants.get(key(grant.userId, grant.id))
      if (!row || row.codeUsedAt !== null) return false
      row.codeUsedAt = now
      return true
    },
    async issue(grant, fresh, now) {
      // The composite foreign key, in memory: no tokens for a grant that is gone.
      if (!grants.has(key(grant.userId, grant.id))) return false
      for (const token of fresh) {
        tokens.set(token.hash, {
          userId: grant.userId,
          grantId: grant.id,
          retiredAt: null,
          createdAt: now,
          parentHash: null,
          ...token,
        } as Token)
      }
      const row = grants.get(key(grant.userId, grant.id))
      if (row) row.lastUsedAt = now
      for (const token of ofGrant(grant.userId, grant.id)) if (token.expiresAt < now) tokens.delete(token.hash)
      return true
    },
    async findToken(hash, kind) {
      const token = tokens.get(hash)
      const grant = token && grants.get(key(token.userId, token.grantId))
      return token && grant && token.kind === kind ? { token: { ...token }, grant: { ...grant } } : null
    },
    async retire(token, now, keepUntil) {
      const row = tokens.get(token.hash)
      if (!row || row.userId !== token.userId || row.retiredAt !== null) return false
      const retire = (target: Token) => {
        target.retiredAt = now
        target.expiresAt = Math.min(target.expiresAt, keepUntil)
      }
      retire(row)
      if (token.parentHash !== null) {
        for (const sibling of ofGrant(token.userId, token.grantId)) {
          const twin = sibling.kind === 'refresh' && sibling.parentHash === token.parentHash
          if (twin && sibling.hash !== token.hash && sibling.retiredAt === null) retire(sibling)
        }
      }
      return true
    },
    successorUsed: async (token) =>
      ofGrant(token.userId, token.grantId).some((child) => child.parentHash === token.hash && child.retiredAt !== null),
    async revoke(userId, grantId) {
      for (const token of ofGrant(userId, grantId)) tokens.delete(token.hash)
      grants.delete(key(userId, grantId))
    },
    list: async (userId, now) =>
      [...grants.values()].filter((grant) => grant.userId === userId && grant.codeUsedAt !== null && live(grant, now)),
    async prune(userId, now) {
      for (const grant of [...grants.values()]) {
        if (grant.userId !== userId) continue
        const abandoned = grant.codeUsedAt === null && grant.codeExpiresAt < now
        const lapsed = grant.codeUsedAt !== null && !live(grant, now)
        if (abandoned || lapsed) await store.revoke(grant.userId, grant.id)
      }
    },
  }
  return { store, grants, tokens }
}

interface Harness {
  deps: OAuthDeps
  grants: Map<string, Grant>
  tokens: Map<string, Token>
  calls: string[]
  /** Moves the server's clock. */
  at(now: number): void
}

function harness(options: { fetcher?: typeof fetch; withinLimit?: OAuthDeps['withinLimit'] } = {}): Harness {
  const { store, grants, tokens } = memoryStore()
  const docs = documents()
  let clock = T0
  return {
    deps: {
      secret: SECRET,
      store,
      fetch: options.fetcher ?? docs.fetcher,
      now: () => clock,
      withinLimit: options.withinLimit,
    },
    grants,
    tokens,
    calls: docs.calls,
    at(now) {
      clock = now
    },
  }
}

const get = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init)

const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

async function call(h: Harness, request: Request): Promise<Response> {
  const response = await handleOAuth(request, h.deps)
  if (!response) throw new Error(`${request.url} was not an OAuth path`)
  return response
}

const location = (response: Response) => new URL(response.headers.get('location')!)

/** The fingerprint a token is stored under. */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** A fresh PKCE pair. */
async function pkce() {
  const verifier = randomToken(32)
  return { verifier, challenge: await sha256Base64Url(verifier) }
}

function authorizeUrl(params: Record<string, string>): string {
  return `/oauth/authorize?${new URLSearchParams(params)}`
}

/**
 * The whole browser leg: authorize, consent as `athlete`, and come back with a code. Each
 * step is the real function the real route calls.
 */
async function connect(
  h: Harness,
  options: { clientId?: string; redirectUri?: string; athlete?: string; state?: string } = {},
) {
  const clientId = options.clientId ?? HOSTED_ID
  const redirectUri = options.redirectUri ?? HOSTED_CALLBACK
  const { verifier, challenge } = await pkce()

  const authorized = await call(
    h,
    get(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: options.state ?? 'st4te',
        resource: RESOURCE,
        scope: 'mcp',
      }),
    ),
  )
  expect(authorized.status).toBe(302)
  const consentUrl = location(authorized)
  expect(consentUrl.pathname).toBe('/autorizar')

  const now = h.deps.now!()
  const pending = await openConsent(consentUrl.searchParams.get('req')!, SECRET, now)
  expect(pending).not.toBeNull()
  const back = new URL(await approveConsent(pending!, options.athlete ?? 'ana', h.deps.store, ORIGIN, now))
  return { code: back.searchParams.get('code')!, back, verifier, clientId, redirectUri }
}

async function exchange(h: Harness, fields: Record<string, string>, headers?: Record<string, string>) {
  const response = await call(h, form('/oauth/token', { grant_type: 'authorization_code', ...fields }, headers))
  return { response, body: (await response.json()) as Record<string, unknown> }
}

async function refresh(h: Harness, token: string, clientId = HOSTED_ID, extra: Record<string, string> = {}) {
  const response = await call(
    h,
    form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, ...extra }),
  )
  return { response, body: (await response.json()) as Record<string, unknown> }
}

/** Connect and exchange in one go — a live connection for `athlete`. */
async function connected(h: Harness, athlete = 'ana') {
  const flow = await connect(h, { athlete })
  const { body } = await exchange(h, {
    code: flow.code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: RESOURCE,
  })
  return { access: body.access_token as string, refresh: body.refresh_token as string }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('serves protected resource metadata at both RFC 9728 locations, naming the MCP URL exactly', async () => {
    const h = harness()
    for (const path of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await call(h, get(path))
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      // Claude requires `resource` to equal the URL the athlete pastes, path included, and
      // uses only the first authorization server.
      expect(body.resource).toBe(`${ORIGIN}/api/mcp`)
      expect(body.authorization_servers).toEqual([ORIGIN])
      expect(body.scopes_supported).toEqual(['mcp'])
    }
  })

  it('names the slash variant exactly too, for an athlete who pasted …/api/mcp/', async () => {
    // Claude requires `resource` to equal the URL as entered, character for character.
    const response = await call(harness(), get('/.well-known/oauth-protected-resource/api/mcp/'))
    expect(((await response.json()) as { resource: string }).resource).toBe(`${ORIGIN}/api/mcp/`)
    expect(bearerChallenge(ORIGIN, undefined, true)).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp/"`,
    )
  })

  it('advertises both halves of the CIMD condition Claude checks before using a metadata document', () => {
    const metadata = authorizationServerMetadata(ORIGIN)
    expect(metadata.client_id_metadata_document_supported).toBe(true)
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
  })

  it('advertises S256, the iss parameter and the endpoints a client needs', () => {
    const metadata = authorizationServerMetadata(ORIGIN)
    expect(metadata.issuer).toBe(ORIGIN)
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
      expect(metadata[endpoint].startsWith(`${ORIGIN}/oauth/`)).toBe(true)
    }
    // Listing it would make Claude ask for it on every connection, for nothing.
    expect(metadata.scopes_supported).not.toContain('offline_access')
  })

  it('serves the authorization server document, CORS-readable, and lets anyone preflight it', async () => {
    const h = harness()
    const response = await call(h, get('/.well-known/oauth-authorization-server'))
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual(authorizationServerMetadata(ORIGIN))

    const preflight = await call(h, get('/oauth/token', { method: 'OPTIONS' }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('leaves every other path to Astro', async () => {
    expect(isOAuthPath('/oauth/token')).toBe(true)
    expect(isOAuthPath('/api/mcp')).toBe(false)
    expect(isOAuthPath('/.well-known/openid-configuration')).toBe(false)
    expect(await handleOAuth(get('/plan'), harness().deps)).toBeNull()
  })

  it('refuses the wrong method with 405 and says which', async () => {
    const response = await call(harness(), get('/oauth/token'))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('points the MCP endpoint’s 401 at the path-suffixed document, with the scope', () => {
    const challenge = bearerChallenge(ORIGIN)
    expect(challenge).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="mcp"`,
    )
    // RFC 6750 §3.1: the error code only when a token was presented.
    expect(bearerChallenge(ORIGIN, 'invalid_token')).toMatch(/^Bearer error="invalid_token", resource_metadata=/)
    expect(protectedResourceMetadata(ORIGIN).resource).toBe(RESOURCE)
  })
})

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

describe('redirect URIs', () => {
  it('allows https, loopback http and a native app’s own scheme', () => {
    for (const uri of [
      HOSTED_CALLBACK,
      'http://localhost:3118/callback',
      'http://127.0.0.1/callback',
      'http://[::1]:9000/cb',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    ]) {
      expect(validRedirectUri(uri), uri).toBe(true)
    }
  })

  it('refuses plain http off loopback, fragments, credentials and script schemes', () => {
    for (const uri of [
      'http://evil.example/cb',
      'https://claude.ai/cb#fragment',
      'https://user:pass@claude.ai/cb',
      'javascript:alert(1)',
      'data:text/html,hi',
      'not a url',
      // A scheme that carries a website: Windows opens this one in a browser at evil.example.
      'microsoft-edge:https://evil.example/cb',
      'app.example:/open?u=https://evil.example/cb',
      // …and the spellings a browser reads the same way, or a parser quietly cleans up.
      'microsoft-edge:https:\\evil.example/cb',
      'microsoft-edge:https:evil.example/cb',
      'microsoft-edge:https:/\t/evil.example/cb',
      'https://claude.ai/cb\n',
    ]) {
      expect(validRedirectUri(uri), uri).toBe(false)
    }
  })

  it('names an app’s own scheme on the consent screen as a scheme, never as a website', () => {
    const client = {
      id: 'dcr.x',
      name: 'Cursor',
      redirectUris: ['cursor://anysphere.cursor-retrieval/oauth/callback'],
      authMethod: 'none' as const,
      kind: 'registered' as const,
    }
    expect(clientIdentity(client, client.redirectUris[0]!)).toMatchObject({
      redirectHost: 'cursor://anysphere.cursor-retrieval',
      verified: false,
      loopback: false,
    })
  })

  it('matches a loopback redirect on any port, as Claude Code needs', () => {
    const registered = CLAUDE_CODE_DOC.redirect_uris
    expect(matchRedirectUri(registered, 'http://localhost:3118/callback')).toBe(true)
    expect(matchRedirectUri(registered, 'http://127.0.0.1:51234/callback')).toBe(true)
    expect(isLoopbackRedirect('http://localhost:3118/callback')).toBe(true)
  })

  it('frees only the port: host and path still have to match', () => {
    const registered = ['http://localhost/callback']
    expect(matchRedirectUri(registered, 'http://localhost:3118/other')).toBe(false)
    expect(matchRedirectUri(registered, 'http://127.0.0.1:3118/callback')).toBe(false)
    expect(matchRedirectUri(registered, 'http://localhost:3118/callback?x=1')).toBe(false)
  })

  it('matches everything else exactly — no port leniency for https, no prefix matching', () => {
    const registered = [HOSTED_CALLBACK]
    expect(matchRedirectUri(registered, HOSTED_CALLBACK)).toBe(true)
    expect(matchRedirectUri(registered, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
    expect(matchRedirectUri(registered, `${HOSTED_CALLBACK}/extra`)).toBe(false)
    expect(matchRedirectUri(registered, 'https://claude.ai/api/mcp/auth_callback?next=evil')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Client identification
// ---------------------------------------------------------------------------

describe('metadata documents', () => {
  it('reads Claude Code’s real document as a public client', async () => {
    const client = await fetchClientDocument(CLAUDE_CODE_ID, documents().fetcher)
    expect(client).toEqual({
      id: CLAUDE_CODE_ID,
      name: 'Claude Code',
      redirectUris: CLAUDE_CODE_DOC.redirect_uris,
      authMethod: 'none',
      kind: 'document',
    })
  })

  it('refuses a document whose client_id is not the URL it came from', async () => {
    const { fetcher } = documents({ [HOSTED_ID]: () => Response.json({ ...HOSTED_DOC, client_id: 'https://other.example/x' }) })
    await expect(fetchClientDocument(HOSTED_ID, fetcher)).rejects.toThrow(/does not match/)
  })

  it('follows no redirect: the identity is the URL, not wherever it points', async () => {
    const { fetcher } = documents({
      [HOSTED_ID]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/doc' } }),
    })
    await expect(fetchClientDocument(HOSTED_ID, fetcher)).rejects.toThrow(/answered 302/)
  })

  it('refuses a document that claims a shared secret, or lists no redirect URIs', async () => {
    const secretive = documents({ [HOSTED_ID]: () => Response.json({ ...HOSTED_DOC, token_endpoint_auth_method: 'client_secret_post' }) })
    await expect(fetchClientDocument(HOSTED_ID, secretive.fetcher)).rejects.toThrow(/public client/)
    const empty = documents({ [HOSTED_ID]: () => Response.json({ ...HOSTED_DOC, redirect_uris: [] }) })
    await expect(fetchClientDocument(HOSTED_ID, empty.fetcher)).rejects.toThrow(/no redirect_uris/)
  })

  it('stops reading an oversized document instead of buffering it', async () => {
    const { fetcher } = documents({ [HOSTED_ID]: () => new Response('x'.repeat(64 * 1024)) })
    await expect(fetchClientDocument(HOSTED_ID, fetcher)).rejects.toThrow(/too large/)
  })

  it('never fetches a client_id aimed at this machine or an IP address', async () => {
    const { fetcher, calls } = documents()
    for (const id of [
      'https://localhost/client',
      'https://127.0.0.1/client',
      'https://[::1]/client',
      'https://intranet/client',
      'https://claude.ai/',
      'https://claude.ai/a/../client',
      'http://claude.ai/client',
    ]) {
      await expect(fetchClientDocument(id, fetcher), id).rejects.toThrow(/metadata document URL/)
    }
    expect(calls).toEqual([])
  })
})

describe('dynamic registration, signed rather than stored', () => {
  it('hands back a client_id that carries its own redirect URIs, and writes nothing', async () => {
    const h = harness()
    const response = await call(
      h,
      new Request(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'MCP Inspector',
          redirect_uris: ['http://localhost:6274/oauth/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      }),
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.client_secret).toBeUndefined()
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(h.grants.size).toBe(0)

    const client = await verifyRegisteredClient(body.client_id as string, await oauthKey(SECRET))
    expect(client?.redirectUris).toEqual(['http://localhost:6274/oauth/callback'])
    expect(client?.name).toBe('MCP Inspector')
  })

  it('defaults to a confidential client, as RFC 7591 says, and derives its secret', async () => {
    const key = await oauthKey(SECRET)
    const body = await registerClient({ redirect_uris: [HOSTED_CALLBACK] }, key, T0)
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic')
    expect(typeof body.client_secret).toBe('string')
  })

  it('refuses a client_id this server did not sign, or one that was edited', async () => {
    const key = await oauthKey(SECRET)
    const { client_id } = await registerClient({ redirect_uris: [HOSTED_CALLBACK], token_endpoint_auth_method: 'none' }, key, T0)
    const [prefix, payload, mac] = [client_id.slice(0, 4), ...client_id.slice(4).split('.')]
    const forged = Buffer.from(JSON.stringify({ r: ['https://evil.example/cb'], m: 'none', t: 0 })).toString('base64url')

    expect(await verifyRegisteredClient(`${prefix}${forged}.${mac}`, key)).toBeNull()
    expect(await verifyRegisteredClient(`${prefix}${payload}.${mac}x`, key)).toBeNull()
    expect(await verifyRegisteredClient(client_id, await oauthKey('another-secret-entirely'))).toBeNull()
  })

  it('refuses bad metadata with the RFC 7591 error codes', async () => {
    const key = await oauthKey(SECRET)
    await expect(registerClient({ redirect_uris: ['http://evil.example/cb'] }, key, T0)).rejects.toMatchObject({
      code: 'invalid_redirect_uri',
    })
    await expect(registerClient({ redirect_uris: [] }, key, T0)).rejects.toMatchObject({ code: 'invalid_redirect_uri' })
    await expect(
      registerClient({ redirect_uris: [HOSTED_CALLBACK], grant_types: ['client_credentials'] }, key, T0),
    ).rejects.toMatchObject({ code: 'invalid_client_metadata' })
    await expect(
      registerClient({ redirect_uris: [HOSTED_CALLBACK], token_endpoint_auth_method: 'private_key_jwt' }, key, T0),
    ).rejects.toMatchObject({ code: 'invalid_client_metadata' })
  })
})

// ---------------------------------------------------------------------------
// The authorization endpoint
// ---------------------------------------------------------------------------

describe('the authorization endpoint', () => {
  const valid = async (overrides: Record<string, string | null> = {}) => {
    const { challenge } = await pkce()
    const params: Record<string, string> = {}
    const base: Record<string, string | null> = {
      response_type: 'code',
      client_id: HOSTED_ID,
      redirect_uri: HOSTED_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st4te',
      resource: RESOURCE,
      ...overrides,
    }
    for (const [name, value] of Object.entries(base)) if (value !== null) params[name] = value
    return authorizeUrl(params)
  }

  it('seals a valid request and sends the browser to the consent screen', async () => {
    const h = harness()
    const response = await call(h, get(await valid()))
    expect(response.status).toBe(302)
    const target = location(response)
    expect(target.origin + target.pathname).toBe(`${ORIGIN}/autorizar`)

    const request = await openConsent(target.searchParams.get('req')!, SECRET, T0)
    expect(request).toMatchObject({
      clientId: HOSTED_ID,
      redirectUri: HOSTED_CALLBACK,
      state: 'st4te',
      scope: 'mcp',
      resource: RESOURCE,
      identity: { host: 'connectors.example', name: 'Claude', verified: true, loopback: false },
    })
    expect(h.grants.size).toBe(0)
  })

  it('accepts Claude Code’s loopback callback on whatever port it opened', async () => {
    const response = await call(harness(), get(await valid({ client_id: CLAUDE_CODE_ID, redirect_uri: 'http://localhost:3118/callback' })))
    const request = await openConsent(location(response).searchParams.get('req')!, SECRET, T0)
    expect(request?.identity).toMatchObject({ host: 'claude.ai', name: 'Claude Code', loopback: true })
  })

  it('never redirects to a client it could not identify, or to a URI that is not its own', async () => {
    const h = harness()
    const unknown = location(await call(h, get(await valid({ client_id: 'made-up' }))))
    expect(unknown.pathname).toBe('/autorizar')
    expect(unknown.searchParams.get('error')).toBe('client')
    // A code and nothing else: free text in this URL would be words anybody could put on
    // the consent screen.
    expect([...unknown.searchParams.keys()]).toEqual(['error'])

    const stray = location(await call(h, get(await valid({ redirect_uri: 'https://evil.example/cb' }))))
    expect(stray.origin).toBe(ORIGIN)
    expect(stray.searchParams.get('error')).toBe('redirect')
  })

  it('sends every later failure back to the client, with its state and our iss', async () => {
    const h = harness()
    const cases: [Record<string, string | null>, string][] = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge: null }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://other.example/api/mcp' }, 'invalid_target'],
    ]
    for (const [overrides, error] of cases) {
      const back = location(await call(h, get(await valid(overrides))))
      expect(back.origin + back.pathname, error).toBe(HOSTED_CALLBACK)
      expect(back.searchParams.get('error')).toBe(error)
      expect(back.searchParams.get('state')).toBe('st4te')
      expect(back.searchParams.get('iss')).toBe(ORIGIN)
    }
  })

  it('binds a request that names no resource to this server anyway', async () => {
    const response = await call(harness(), get(await valid({ resource: null })))
    const request = await openConsent(location(response).searchParams.get('req')!, SECRET, T0)
    expect(request?.resource).toBe(RESOURCE)
  })

  it('accepts the resource with a trailing slash or an upper-case host', () => {
    expect(sameResource(`${RESOURCE}/`, RESOURCE)).toBe(true)
    expect(sameResource('HTTPS://TREXIMO.EXAMPLE/api/mcp', RESOURCE)).toBe(true)
    expect(sameResource(`${RESOURCE}?x=1`, RESOURCE)).toBe(false)
    expect(sameResource('https://treximo.example/api', RESOURCE)).toBe(false)
  })

  it('throttles before it fetches anything', async () => {
    const h = harness({ withinLimit: async () => false })
    const response = await call(h, get(await valid()))
    expect(response.status).toBe(429)
    expect(h.calls).toEqual([])
  })
})

describe('the sealed request', () => {
  it('is refused once it is stale, edited or signed by another deployment', async () => {
    const key = await oauthKey(SECRET)
    const request = {
      clientId: HOSTED_ID,
      redirectUri: HOSTED_CALLBACK,
      state: null,
      codeChallenge: 'x'.repeat(43),
      scope: 'mcp',
      resource: RESOURCE,
      identity: { name: 'Claude', host: 'connectors.example', redirectHost: 'claude.ai', verified: true, loopback: false },
      expiresAt: T0 + REQUEST_TTL_MS,
    }
    const sealed = await sealRequest(request, key)
    expect(await openRequest(sealed, key, T0)).toEqual(request)
    expect(await openRequest(sealed, key, T0 + REQUEST_TTL_MS)).toBeNull()

    const [payload, mac] = sealed.split('.')
    const edited = Buffer.from(JSON.stringify({ ...request, redirectUri: 'https://evil.example/cb' })).toString('base64url')
    expect(await openRequest(`${edited}.${mac}`, key, T0)).toBeNull()
    expect(await openRequest(`${payload}.${mac}`, await oauthKey('another-secret-entirely'), T0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Consent and the code exchange
// ---------------------------------------------------------------------------

describe('consent', () => {
  it('approving mints a code for the athlete and returns it with state and iss', async () => {
    const h = harness()
    const { back, code } = await connect(h, { athlete: 'ana' })
    expect(back.origin + back.pathname).toBe(HOSTED_CALLBACK)
    expect(back.searchParams.get('state')).toBe('st4te')
    expect(back.searchParams.get('iss')).toBe(ORIGIN)
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [grant] = [...h.grants.values()]
    expect(grant).toMatchObject({ userId: 'ana', clientId: HOSTED_ID, clientName: 'Claude', codeExpiresAt: T0 + CODE_TTL_MS })
    // Only the hash is stored.
    expect(JSON.stringify(grant)).not.toContain(code)
  })

  it('declining sends access_denied back to the client', async () => {
    const key = await oauthKey(SECRET)
    const request = await openRequest(
      await sealRequest(
        {
          clientId: HOSTED_ID,
          redirectUri: HOSTED_CALLBACK,
          state: 'st4te',
          codeChallenge: 'x'.repeat(43),
          scope: 'mcp',
          resource: RESOURCE,
          identity: { name: 'Claude', host: 'x', redirectHost: 'claude.ai', verified: true, loopback: false },
          expiresAt: T0 + 1000,
        },
        key,
      ),
      key,
      T0,
    )
    const back = new URL(denyConsent(request!, ORIGIN))
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('st4te')
    expect(back.searchParams.get('iss')).toBe(ORIGIN)
  })

  it('prunes the athlete’s abandoned codes and only theirs', async () => {
    const h = harness()
    await connect(h, { athlete: 'ana' })
    await connect(h, { athlete: 'marc' })
    h.at(T0 + CODE_TTL_MS + 1)
    await connect(h, { athlete: 'ana' })
    expect([...h.grants.values()].map((grant) => grant.userId).sort()).toEqual(['ana', 'marc'])
  })
})

describe('the code exchange', () => {
  it('trades a code and its verifier for a bearer pair bound to this server', async () => {
    const h = harness()
    const flow = await connect(h)
    const { response, body } = await exchange(h, {
      code: flow.code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
      resource: RESOURCE,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, scope: 'mcp' })

    expect(await resolveAccessToken(h.deps.store, body.access_token as string, RESOURCE, T0)).toBe('ana')
    // RFC 8707: not for another server, and not after the hour is up.
    expect(await resolveAccessToken(h.deps.store, body.access_token as string, 'https://other.example/api/mcp', T0)).toBeNull()
    expect(await resolveAccessToken(h.deps.store, body.access_token as string, RESOURCE, T0 + ACCESS_TTL_MS)).toBeNull()
  })

  it('refuses a wrong verifier, a wrong client, a wrong redirect and a wrong resource', async () => {
    const h = harness()
    const flow = await connect(h)
    const base = { code: flow.code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.verifier }

    const cases: [Record<string, string>, string][] = [
      [{ code_verifier: randomToken(32) }, 'invalid_grant'],
      [{ client_id: CLAUDE_CODE_ID }, 'invalid_grant'],
      [{ redirect_uri: 'https://claude.ai/elsewhere' }, 'invalid_grant'],
      [{ resource: 'https://other.example/api/mcp' }, 'invalid_target'],
      [{ code: 'not-a-code' }, 'invalid_grant'],
    ]
    for (const [overrides, error] of cases) {
      const { response, body } = await exchange(h, { ...base, ...overrides })
      expect(response.status, JSON.stringify(overrides)).toBe(400)
      expect(body.error).toBe(error)
    }

    // None of those burned the code.
    expect((await exchange(h, base)).response.status).toBe(200)
  })

  it('refuses an expired code', async () => {
    const h = harness()
    const flow = await connect(h)
    h.at(T0 + CODE_TTL_MS)
    const { body } = await exchange(h, {
      code: flow.code,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
    })
    expect(body.error).toBe('invalid_grant')
  })

  it('treats a second use of a code as theft, and revokes what the first one opened', async () => {
    const h = harness()
    const flow = await connect(h)
    const fields = { code: flow.code, client_id: flow.clientId, code_verifier: flow.verifier }
    const first = await exchange(h, fields)
    expect(first.response.status).toBe(200)

    const second = await exchange(h, fields)
    expect(second.body.error).toBe('invalid_grant')
    expect(await resolveAccessToken(h.deps.store, first.body.access_token as string, RESOURCE, T0)).toBeNull()
    expect(h.grants.size).toBe(0)
  })

  it('revokes on the loser of two exchanges racing on one code, too', async () => {
    const h = harness()
    const flow = await connect(h)
    const fields = { code: flow.code, client_id: flow.clientId, code_verifier: flow.verifier }
    const [a, b] = await Promise.all([exchange(h, fields), exchange(h, fields)])
    // Whichever order the two land in, at most one is answered with tokens — and none of
    // them outlives the replay. (Here the loser revokes before the winner stores its pair,
    // so both are refused; on D1 the winner may answer first and lose its tokens after.)
    expect([a, b].filter(({ response }) => response.status === 200).length).toBeLessThanOrEqual(1)
    for (const { body } of [a, b]) {
      if (body.access_token) {
        expect(await resolveAccessToken(h.deps.store, body.access_token as string, RESOURCE, T0)).toBeNull()
      }
    }
    expect(h.grants.size).toBe(0)
  })

  it('does not let another client burn somebody else’s used code', async () => {
    const h = harness()
    const flow = await connect(h)
    await exchange(h, { code: flow.code, client_id: flow.clientId, code_verifier: flow.verifier })
    const stranger = await exchange(h, { code: flow.code, client_id: CLAUDE_CODE_ID, code_verifier: flow.verifier })
    expect(stranger.body.error).toBe('invalid_grant')
    expect(h.grants.size).toBe(1)
  })

  it('makes a confidential client prove its secret, by Basic or in the body', async () => {
    const h = harness()
    const key = await oauthKey(SECRET)
    const registration = await registerClient(
      { redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_basic' },
      key,
      T0,
    )
    const run = async () => connect(h, { clientId: registration.client_id, redirectUri: 'https://app.example/cb' })

    const withoutSecret = await run()
    const refused = await exchange(h, {
      code: withoutSecret.code,
      client_id: registration.client_id,
      code_verifier: withoutSecret.verifier,
    })
    expect(refused.response.status).toBe(401)
    expect(refused.body.error).toBe('invalid_client')

    const basic = `Basic ${Buffer.from(`${encodeURIComponent(registration.client_id)}:${encodeURIComponent(registration.client_secret!)}`).toString('base64')}`
    const viaBasic = await exchange(h, { code: withoutSecret.code, code_verifier: withoutSecret.verifier }, { authorization: basic })
    expect(viaBasic.response.status).toBe(200)

    const again = await run()
    const viaBody = await exchange(h, {
      code: again.code,
      client_id: registration.client_id,
      client_secret: registration.client_secret!,
      code_verifier: again.verifier,
    })
    expect(viaBody.response.status).toBe(200)
  })

  it('reads the form Claude sends, and forgives a JSON body', async () => {
    const h = harness()
    const flow = await connect(h)
    const response = await call(
      h,
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: flow.code,
          client_id: flow.clientId,
          code_verifier: flow.verifier,
        }),
      }),
    )
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Refresh, rotation and revocation
// ---------------------------------------------------------------------------

describe('refresh', () => {
  it('rotates the refresh token, and lets the old access token live out its hour', async () => {
    const h = harness()
    const first = await connected(h)
    h.at(T0 + ACCESS_TTL_MS - 60_000)

    const { response, body } = await refresh(h, first.refresh)
    expect(response.status).toBe(200)
    expect(body.refresh_token).not.toBe(first.refresh)

    const now = h.deps.now!()
    expect(await resolveAccessToken(h.deps.store, body.access_token as string, RESOURCE, now)).toBe('ana')
    // A refresh is not an alarm: an access token already handed out is not withdrawn by it.
    expect(await resolveAccessToken(h.deps.store, first.access, RESOURCE, now)).toBe('ana')
    expect(await resolveAccessToken(h.deps.store, first.access, RESOURCE, T0 + ACCESS_TTL_MS)).toBeNull()
  })

  it('serves two refreshes racing on one token, and either answer keeps the client connected', async () => {
    // Claude refreshes ahead of expiry *and* on a 401, so parallel tool calls can do both.
    const h = harness()
    const first = await connected(h)
    const [a, b] = await Promise.all([refresh(h, first.refresh), refresh(h, first.refresh)])
    expect(a.response.status).toBe(200)
    expect(b.response.status).toBe(200)

    // The client kept `b`. It goes on working…
    const next = await refresh(h, b.body.refresh_token as string)
    expect(next.response.status).toBe(200)
    expect(await resolveAccessToken(h.deps.store, next.body.access_token as string, RESOURCE, T0)).toBe('ana')
    // …and the twin it threw away stopped being a live credential the moment it did.
    const twin = h.tokens.get(await sha256(a.body.refresh_token as string))
    expect(twin?.retiredAt).not.toBeNull()
  })

  it('lets a client that lost the answer ask again within the grace window', async () => {
    const h = harness()
    const first = await connected(h)
    const lost = await refresh(h, first.refresh)
    expect(lost.response.status).toBe(200)

    h.at(T0 + REFRESH_GRACE_MS)
    const retried = await refresh(h, first.refresh)
    expect(retried.response.status).toBe(200)
    expect((await refresh(h, retried.body.refresh_token as string)).response.status).toBe(200)
  })

  it('treats a used token presented after the grace window as stolen, and revokes the connection', async () => {
    const h = harness()
    const first = await connected(h)
    const legit = await refresh(h, first.refresh)

    // A copy of the old token, presented later — by somebody.
    h.at(T0 + REFRESH_GRACE_MS + 1)
    const thief = await refresh(h, first.refresh)
    expect(thief.body.error).toBe('invalid_grant')

    // There is no telling which holder is the athlete's client, so both lose everything.
    expect(await resolveAccessToken(h.deps.store, legit.body.access_token as string, RESOURCE, h.deps.now!())).toBeNull()
    expect((await refresh(h, legit.body.refresh_token as string)).body.error).toBe('invalid_grant')
    expect(h.grants.size).toBe(0)
  })

  it('treats a token as stolen once its successor was used, however soon', async () => {
    const h = harness()
    const first = await connected(h)
    const second = await refresh(h, first.refresh)
    expect((await refresh(h, second.body.refresh_token as string)).response.status).toBe(200)

    // Same instant, inside the grace window — but the client has already moved two steps on.
    expect((await refresh(h, first.refresh)).body.error).toBe('invalid_grant')
    expect(h.grants.size).toBe(0)
  })

  it('also catches the thief who refreshed first, when the athlete’s client comes back', async () => {
    const h = harness()
    const first = await connected(h)
    const thief = await refresh(h, first.refresh)
    expect(thief.response.status).toBe(200)

    h.at(T0 + REFRESH_GRACE_MS + 1)
    expect((await refresh(h, first.refresh)).body.error).toBe('invalid_grant')
    expect(await resolveAccessToken(h.deps.store, thief.body.access_token as string, RESOURCE, h.deps.now!())).toBeNull()
  })

  it('judges a token a concurrent refresh retired under it as retired, not as a free pass', async () => {
    // The store says the claim was lost; the token, read again, turns out to have a used
    // successor — so this is a copy, and it is refused rather than served as a twin.
    const h = harness()
    const first = await connected(h)
    const second = await refresh(h, first.refresh)
    const store = h.deps.store
    const findToken = store.findToken.bind(store)
    let stale = true
    store.findToken = async (hash, kind) => {
      const found = await findToken(hash, kind)
      // The first read sees the token as it was before anybody used it.
      if (stale && found && kind === 'refresh' && hash === sha256(first.refresh)) {
        stale = false
        return { ...found, token: { ...found.token, retiredAt: null } }
      }
      return found
    }
    await refresh(h, second.body.refresh_token as string)
    stale = true
    expect((await refresh(h, first.refresh)).body.error).toBe('invalid_grant')
    expect(h.grants.size).toBe(0)
  })

  it('answers invalid_grant, not a server error, when the connection is revoked mid-refresh', async () => {
    const h = harness()
    const first = await connected(h)
    const store = h.deps.store
    const retire = store.retire.bind(store)
    store.retire = async (token, now, keep) => {
      const claimed = await retire(token, now, keep)
      await store.revoke(token.userId, token.grantId)
      return claimed
    }
    const { response, body } = await refresh(h, first.refresh)
    expect(response.status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })

  it('catches a successor used while a grace request was minting its twin', async () => {
    const h = harness()
    const first = await connected(h)
    const second = await refresh(h, first.refresh)
    const store = h.deps.store
    const issue = store.issue.bind(store)
    let interleave = true
    store.issue = async (grant, fresh, now) => {
      const stored = await issue(grant, fresh, now)
      if (interleave) {
        // Between the grace check and the insert, somebody used the successor.
        interleave = false
        await refresh(h, second.body.refresh_token as string)
      }
      return stored
    }
    expect((await refresh(h, first.refresh)).body.error).toBe('invalid_grant')
    expect(h.grants.size).toBe(0)
  })

  it('forgets a retired token after a week, and never lets one work again', async () => {
    const h = harness()
    const first = await connected(h)
    await refresh(h, first.refresh)
    h.at(T0 + RETIRED_RETENTION_MS + 1)
    expect((await refresh(h, first.refresh)).body.error).toBe('invalid_grant')
  })

  it('gives each new refresh token a fresh sixty days, and answers invalid_grant once one lapses', async () => {
    const h = harness()
    const first = await connected(h)
    h.at(T0 + REFRESH_TTL_MS - 1)
    const kept = await refresh(h, first.refresh)
    expect(kept.response.status).toBe(200)

    h.at(T0 + REFRESH_TTL_MS - 1 + REFRESH_TTL_MS)
    expect((await refresh(h, kept.body.refresh_token as string)).body.error).toBe('invalid_grant')
  })

  it('lists a connection while it has a live refresh token, and prunes it once it has none', async () => {
    const h = harness()
    await connected(h)
    expect(await h.deps.store.list('ana', T0)).toHaveLength(1)
    h.at(T0 + REFRESH_TTL_MS + 1)
    expect(await h.deps.store.list('ana', h.deps.now!())).toHaveLength(0)
    await h.deps.store.prune('ana', h.deps.now!())
    expect(h.grants.size).toBe(0)
  })

  it('refuses another client’s refresh token, and a scope that was never granted', async () => {
    const h = harness()
    const { refresh: token } = await connected(h)
    expect((await refresh(h, token, CLAUDE_CODE_ID)).body.error).toBe('invalid_grant')
    expect((await refresh(h, token, HOSTED_ID, { scope: 'mcp admin' })).body.error).toBe('invalid_scope')
    expect((await refresh(h, token, HOSTED_ID, { scope: 'mcp' })).response.status).toBe(200)
  })

  it('answers an unknown grant type with unsupported_grant_type', async () => {
    const h = harness()
    const response = await call(h, form('/oauth/token', { grant_type: 'client_credentials', client_id: HOSTED_ID }))
    expect(((await response.json()) as { error: string }).error).toBe('unsupported_grant_type')
  })
})

describe('revocation', () => {
  it('revokes the whole connection from either token, and only for the client that holds it', async () => {
    const h = harness()
    const { access, refresh: token } = await connected(h)

    const stranger = await call(h, form('/oauth/revoke', { token, client_id: CLAUDE_CODE_ID }))
    expect(stranger.status).toBe(400)
    expect(await resolveAccessToken(h.deps.store, access, RESOURCE, T0)).toBe('ana')

    const response = await call(h, form('/oauth/revoke', { token, client_id: HOSTED_ID }))
    expect(response.status).toBe(200)
    expect(await resolveAccessToken(h.deps.store, access, RESOURCE, T0)).toBeNull()
  })

  it('answers 200 for a token it has never seen, as RFC 7009 says', async () => {
    const response = await call(harness(), form('/oauth/revoke', { token: 'whatever', client_id: HOSTED_ID }))
    expect(response.status).toBe(200)
  })
})

describe('tenancy', () => {
  it('keeps two athletes’ connections apart, even through the same client', async () => {
    const h = harness()
    const ana = await connected(h, 'ana')
    const marc = await connected(h, 'marc')
    expect(await resolveAccessToken(h.deps.store, ana.access, RESOURCE, T0)).toBe('ana')
    expect(await resolveAccessToken(h.deps.store, marc.access, RESOURCE, T0)).toBe('marc')

    const [anaGrant] = [...h.grants.values()].filter((grant) => grant.userId === 'ana')
    await h.deps.store.revoke('marc', anaGrant!.id)
    expect(await resolveAccessToken(h.deps.store, ana.access, RESOURCE, T0)).toBe('ana')
  })

  it('names userId in every statement that writes to either table', () => {
    // The same crude scan `mcp.test.ts` runs over `tools.ts`, for the same reason: a write
    // keyed on `id` alone is the bug that passed every other test the first time. Each
    // update or delete is read up to the next statement, and must filter on its own
    // table's `userId`.
    const source = readFileSync(new URL('../../src/lib/oauth/grants.ts', import.meta.url), 'utf8')
    const starts = [...source.matchAll(/db\s*\.\s*(?:update|delete|insert|select)\(/g)].map((m) => m.index!)
    const writes = [...source.matchAll(/db\s*\.\s*(?:update|delete)\((oauth\w+)\)/g)]
    expect(writes.length).toBe(8)
    for (const write of writes) {
      const end = starts.find((at) => at > write.index!) ?? source.length
      const statement = source.slice(write.index!, end)
      expect(statement, statement.slice(0, 60)).toContain(`eq(${write[1]}.userId, `)
    }
  })
})
