import { json } from '../api'
import { timingSafeEqual } from '../crypto'

/**
 * The MCP wire, and nothing else.
 *
 * `handleMcp` knows how a JSON-RPC message arrives, which protocol revision the caller is
 * speaking and whether it is allowed to speak at all. It does not know what a training
 * plan is: the tools are handed in as a registry, so this file can be tested against a
 * stub in plain Node with a fabricated `Request` and no D1, no bindings and no clock.
 *
 * Transport is **Streamable HTTP, stateless, JSON only**. One endpoint, POST only, one
 * JSON object in and one JSON object out. Three things this deliberately does not do:
 *
 *  - **No SSE.** The spec allows a server to answer a request with an event stream, and
 *    every one of these tools is a single D1 read or write that returns in milliseconds.
 *    Holding a connection open would buy latency we do not have and cost a Worker
 *    invocation that stays billable for as long as the client keeps the socket.
 *  - **No sessions.** `Mcp-Session-Id` and `Last-Event-ID` are read by nothing here and
 *    minted by nothing here. The 2026-07-28 revision removed protocol-level sessions
 *    outright, and there is no state between two calls that a session id could name —
 *    every tool reads the database fresh.
 *  - **No GET stream.** `GET` and `DELETE` are answered `405`, which is how an older
 *    client that still tries to open the server-initiated stream is told to stop.
 *
 * Two eras have to work at once, because a forker's client is whichever one their MCP
 * SDK shipped with. The legacy era (2025-06-18, 2025-11-25) opens with an `initialize`
 * handshake and then carries its version in a header; the modern era (2026-07-28) has no
 * handshake at all and puts the version on every single request, in `params._meta` and
 * mirrored in a header. A request carrying no version anywhere is served as legacy and
 * leniently — that is what a bare `curl` looks like, and checking the thing is alive with
 * one is the first thing anybody does with a server they just deployed.
 */

/** Newest first. The first entry is what we answer with when the client asks for nothing. */
export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number]
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = PROTOCOL_VERSIONS[0]

/** The revision that dropped the handshake — the fork in the road for every branch below. */
const MODERN = LATEST_PROTOCOL_VERSION

const isSupported = (value: string): value is ProtocolVersion =>
  (PROTOCOL_VERSIONS as readonly string[]).includes(value)

/**
 * JSON-RPC's own codes, plus the two MCP added and one of ours.
 *
 * `-32001` is in the `-32000…-32099` band JSON-RPC reserves for the implementation, which
 * is where an auth failure belongs: the protocol has no opinion about credentials, and
 * `401` on the envelope is the part a client actually branches on.
 */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  /** 2026-07-28: a mirrored header disagrees with the body field it mirrors. */
  HEADER_MISMATCH: -32020,
  /** 2026-07-28: the version asked for is not one we speak. */
  UNSUPPORTED_VERSION: -32022,
} as const

/** Where 2026-07-28 puts the protocol version on every request. */
const VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
/** Where `server/discover` puts what `initialize` used to return as `serverInfo`. */
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'

// ---------------------------------------------------------------------------
// What a tool looks like from here
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: 'text'
  text: string
}

/**
 * A tool's answer. `isError` is not a transport failure: a session that failed validation
 * is a result the agent can read, fix and retry, so it comes back as content on a
 * successful JSON-RPC response rather than as an error the client SDK throws.
 */
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  title?: string
  description: string
  /** Hand-written JSON Schema — see the comment on `tools.ts` for why it is not generated. */
  inputSchema: Record<string, unknown>
}

/** One athlete's tools, built after their token has been resolved. */
export interface ToolRegistry {
  list(): ToolDefinition[]
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>
}

/**
 * Everything `handleMcp` needs that is not the request itself.
 *
 * Nothing here reads `cloudflare:workers`, which is the whole reason the transport is
 * testable in Node: the route wires the real database and limiter in, and a test wires
 * stubs in.
 *
 * The shape of `resolve` is the security model. There is no shared secret to compare
 * against any more — a bearer token is *looked up*, and what comes back is one athlete's
 * registry with their id already bound into every query behind it. A token that belongs to
 * nobody resolves to `null` and the request is refused before its body is read. That also
 * removes a whole class of mistake: there is no way to obtain a registry without having
 * proved whose it is.
 */
export interface McpServer {
  serverInfo: { name: string; version: string }
  /** How an agent should approach this server. Returned by `initialize` and `server/discover`. */
  instructions: string
  resolve(token: string): Promise<ToolRegistry | null>
  /**
   * `false` when this caller has asked too often and should be turned away unread. Omitted
   * — by a test, or by a fork with no limiter configured — means no limiting.
   */
  withinLimit?: (request: Request) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ok = (id: JsonRpcId, result: unknown) => json({ jsonrpc: '2.0', id, result })

const fail = (
  id: JsonRpcId,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response =>
  json({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }, status)

/**
 * How a JSON-RPC error rides on the HTTP envelope, which is the one place the two eras
 * genuinely disagree.
 *
 * A legacy client reads the error out of a `200` body — its SDK treats any non-2xx as a
 * *transport* failure and throws before it ever looks at the JSON, so answering `404` to
 * `tools/call` on a method it mistyped would surface as "the server is down" rather than
 * as "no such method". 2026-07-28 maps the codes onto statuses instead, and a client that
 * asked for that revision expects them.
 *
 * The two version errors below are outside this: they are answered `400` whoever asked,
 * because a request whose headers contradict its body is malformed at the HTTP layer.
 */
const statusFor = (code: number, modern: boolean): number => {
  if (!modern) return 200
  if (code === RPC.METHOD_NOT_FOUND) return 404
  if (code === RPC.INTERNAL_ERROR) return 500
  return 400
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * DNS-rebinding protection, which the spec requires of every local HTTP transport.
 *
 * A page on `evil.example` can make the browser resolve its own hostname to `127.0.0.1`
 * and then POST to whatever is listening there; the `Origin` header is the one thing that
 * still says where the code came from. An absent `Origin` is normal and allowed — a CLI
 * client sends none at all, and that is the common case here — so this only rejects a
 * request that names an origin and names the wrong one.
 */
function checkOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (origin === null || origin === new URL(request.url).origin) return null
  return fail(null, RPC.INVALID_REQUEST, 'Origin not allowed', 403)
}

/** The bearer token as presented, or `''` when the header is missing or not a bearer. */
function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  const space = header.indexOf(' ')
  const scheme = space < 0 ? header : header.slice(0, space)
  if (scheme.toLowerCase() !== 'bearer') return ''
  return space < 0 ? '' : header.slice(space + 1).trim()
}

/** One sentence for every way a token can fail, so none of them is an oracle. */
function unauthorized(): Response {
  const response = fail(
    null,
    RPC.UNAUTHORIZED,
    'Send `Authorization: Bearer <token>` with the MCP token from /ajustes.',
    401,
  )
  response.headers.set('www-authenticate', 'Bearer')
  return response
}

/**
 * 2026-07-28 mirrors three body fields into headers so a proxy can route without parsing
 * the body. A mirror that disagrees with what it mirrors is a request that means two
 * things at once, and guessing which is a way to route a `tools/call` at the wrong tool —
 * so it is refused rather than reconciled.
 */
const disagree = (header: string | null, body: string | null, label: string): string | null =>
  header !== null && body !== null && header !== body
    ? `${label}: header says "${header}", body says "${body}"`
    : null

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

export async function handleMcp(request: Request, server: McpServer): Promise<Response> {
  if (request.method !== 'POST') {
    const response = fail(
      null,
      RPC.INVALID_REQUEST,
      'This MCP endpoint is POST-only: it has no server-initiated stream and no sessions to delete.',
      405,
    )
    response.headers.set('allow', 'POST')
    return response
  }

  const foreign = checkOrigin(request)
  if (foreign) return foreign

  // Ahead of the bearer check, never behind it. A limiter a correct token can skip is a
  // limiter that throttles the status code and not the guessing — see
  // `src/lib/ratelimit.ts`. The ceiling is set for an agent writing a whole block in a
  // burst, so a legitimate caller does not meet it.
  if (server.withinLimit && !(await server.withinLimit(request))) {
    return fail(
      null,
      RPC.UNAUTHORIZED,
      'Too many requests. Wait a minute and try again.',
      429,
    )
  }

  // Looked up, not compared. `resolve` hashes the token and finds the athlete it belongs
  // to; what comes back is *their* tools, with their id already bound into every query.
  // A token belonging to nobody is refused here, before the body is even read.
  const token = bearerToken(request)
  const tools = token === '' ? null : await server.resolve(token)
  if (!tools) return unauthorized()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail(null, RPC.PARSE_ERROR, 'Request body is not valid JSON', 400)
  }

  // Batching was removed in 2025-06-18 and never came back, so an array is a client
  // speaking a revision this server does not support rather than a shape to unpack.
  if (!isRecord(body)) {
    return fail(null, RPC.INVALID_REQUEST, 'Expected a single JSON-RPC request object', 400)
  }

  // JSON-RPC says a notification is a message with no `id` member at all. An explicit
  // `null` is a request whose id happens to be null, and it gets an answer.
  const notification = body.id === undefined
  const id = (body.id ?? null) as JsonRpcId
  const method = body.method
  if (typeof method !== 'string') {
    return fail(id, RPC.INVALID_REQUEST, '`method` is required and must be a string', 400)
  }

  const params = isRecord(body.params) ? body.params : {}
  const meta = isRecord(params._meta) ? params._meta : {}
  const bodyVersion = typeof meta[VERSION_META_KEY] === 'string' ? meta[VERSION_META_KEY] : null
  const headerVersion = request.headers.get('mcp-protocol-version')
  const toolName = typeof params.name === 'string' ? params.name : null

  const mismatch =
    disagree(headerVersion, bodyVersion, 'MCP-Protocol-Version') ??
    disagree(request.headers.get('mcp-method'), method, 'Mcp-Method') ??
    disagree(request.headers.get('mcp-name'), toolName, 'Mcp-Name')
  if (mismatch) return fail(id, RPC.HEADER_MISMATCH, mismatch, 400)

  const requested = bodyVersion ?? headerVersion
  if (requested !== null && !isSupported(requested)) {
    return fail(id, RPC.UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
      supported: [...PROTOCOL_VERSIONS],
      requested,
    })
  }
  const modern = requested === MODERN

  // Nothing here is long-running and nothing is queued, so an accepted notification is
  // simply an empty 202 — `notifications/initialized` included.
  if (notification) return new Response(null, { status: 202 })

  switch (method) {
    /**
     * The legacy handshake. Echo the version the client asked for when we speak it;
     * otherwise answer with our newest and let the client decide whether it can live with
     * that, which is what the spec prescribes for a version it does not recognise.
     */
    case 'initialize': {
      const asked = params.protocolVersion
      return ok(id, {
        protocolVersion:
          typeof asked === 'string' && isSupported(asked) ? asked : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: server.serverInfo,
        instructions: server.instructions,
      })
    }

    case 'ping':
      return ok(id, {})

    /**
     * 2026-07-28's replacement for the handshake, and mandatory in it: one round trip that
     * says which revisions the server speaks, what it can do and how to approach it, with
     * no state created on either side. Served in both eras — it costs nothing, and it is
     * the friendliest thing a bare `curl` can be pointed at.
     */
    case 'server/discover':
      return ok(id, {
        resultType: 'complete',
        supportedVersions: [...PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        instructions: server.instructions,
        _meta: { [SERVER_INFO_META_KEY]: server.serverInfo },
      })

    case 'tools/list':
      return ok(id, { tools: tools.list() })

    case 'tools/call': {
      if (toolName === null) {
        return fail(
          id,
          RPC.INVALID_PARAMS,
          '`params.name` is required and must be a string',
          statusFor(RPC.INVALID_PARAMS, modern),
        )
      }
      if (!tools.list().some((tool) => tool.name === toolName)) {
        return fail(
          id,
          RPC.INVALID_PARAMS,
          `Unknown tool "${toolName}". Call tools/list for the ones this server has.`,
          statusFor(RPC.INVALID_PARAMS, modern),
        )
      }

      const args = isRecord(params.arguments) ? params.arguments : {}
      try {
        return ok(id, await tools.call(toolName, args))
      } catch (cause) {
        // A registry that throws rather than returning `isError` is still describing
        // something the agent did, so it is answered as a result and not as a dead socket.
        return ok(id, {
          content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }],
          isError: true,
        })
      }
    }

    default:
      return fail(
        id,
        RPC.METHOD_NOT_FOUND,
        `Unknown method "${method}"`,
        statusFor(RPC.METHOD_NOT_FOUND, modern),
      )
  }
}
