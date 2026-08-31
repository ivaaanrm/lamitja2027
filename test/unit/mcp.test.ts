import { describe, expect, it } from 'vitest'
import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  RPC,
  handleMcp,
  type McpServer,
  type ToolRegistry,
} from '@/lib/mcp/protocol'
import {
  SERVER_INSTRUCTIONS,
  blockBrief,
  createToolRegistry,
  fromIsoDate,
  fromPace,
  toIsoDate,
  toPace,
  withDerivedDistance,
} from '@/lib/mcp/tools'
import { HALF_MARATHON_M, goalPaceSKm, totalWeeks, type BlockConfig } from '@/lib/block'
import { DEFAULT_HR_MAX, PACE_ZONES, paceBands } from '@/lib/paces'
import { PRESCRIPTION_KINDS, SESSION_TYPES } from '@/lib/plan'
import { STRATEGIES } from '@/lib/prescription'
import { BUILTIN_TEMPLATES, sessionFromTemplate } from '@/lib/starters'
import type { Database } from '@/lib/db/client'

/**
 * The transport is tested against a stub registry and fabricated `Request` objects, in
 * plain Node — no D1, no bindings, no Worker. That is the whole reason `handleMcp` takes
 * its tools and its credential as arguments instead of reaching for `cloudflare:workers`:
 * every branch below is a wire-format decision, and none of them should need a database
 * to check.
 */

const SECRET = 'correct-horse-battery-staple'
const URL_ = 'https://lamitja.example/api/mcp'
const VERSION_META = 'io.modelcontextprotocol/protocolVersion'

/**
 * One athlete's block, written out. Every tool test below runs against this rather than
 * against whatever `.env` the machine carries — see `block.test.ts` for why.
 */
const BLOCK: BlockConfig = {
  startsOn: Date.UTC(2026, 7, 17),
  raceOn: Date.UTC(2027, 0, 24),
  goalTimeS: 4799,
  raceDistanceM: HALF_MARATHON_M,
  raceName: 'La Mitja',
  racePlace: 'Granollers',
}

const stubTools = (): ToolRegistry => ({
  list: () => [
    { name: 'echo', title: 'Echo', description: 'Echoes its arguments.', inputSchema: { type: 'object' } },
    { name: 'boom', description: 'Always fails.', inputSchema: { type: 'object' } },
    { name: 'throws', description: 'Throws.', inputSchema: { type: 'object' } },
  ],
  call: async (name, args) => {
    if (name === 'throws') throw new Error('handler exploded')
    if (name === 'boom') return { content: [{ type: 'text', text: 'row 3 is invalid' }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify(args) }] }
  },
})

/**
 * The server the transport is handed. `resolve` stands in for the token lookup: only
 * `SECRET` belongs to anybody, and everything else resolves to `null` — which is exactly
 * the shape `resolveMcpToken` has against the real table.
 */
function stubRegistry(): McpServer {
  return {
    serverInfo: { name: 'test-server', version: '9.9.9' },
    instructions: 'Call get_block first.',
    resolve: async (token: string) => (token === SECRET ? stubTools() : null),
  }
}

interface Envelope {
  jsonrpc?: string
  id?: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

function post(
  body: unknown,
  options: { headers?: Record<string, string>; auth?: string | null; method?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
  if (options.auth !== null) headers.authorization = `Bearer ${options.auth ?? SECRET}`

  const method = options.method ?? 'POST'
  return new Request(URL_, {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
}

const send = async (
  body: unknown,
  options?: Parameters<typeof post>[1],
): Promise<{ status: number; response: Response; json: Envelope }> => {
  const response = await handleMcp(post(body, options), stubRegistry())
  const text = await response.clone().text()
  return { status: response.status, response, json: text === '' ? {} : (JSON.parse(text) as Envelope) }
}

const request = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params ? { params } : {}),
})

/** The same request, tagged as 2026-07-28 in both the places that revision puts it. */
const modern = (method: string, params: Record<string, unknown> = {}) => ({
  body: request(method, { ...params, _meta: { [VERSION_META]: LATEST_PROTOCOL_VERSION } }),
  options: { headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } },
})

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('the endpoint is POST-only', () => {
  it('answers GET with 405 and says so', async () => {
    const { status, response, json } = await send(null, { method: 'GET' })
    expect(status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(json.error?.code).toBe(RPC.INVALID_REQUEST)
  })

  it('answers DELETE with 405 — there is no session to delete', async () => {
    expect((await send(null, { method: 'DELETE' })).status).toBe(405)
  })
})

describe('DNS-rebinding protection', () => {
  it('rejects a foreign Origin', async () => {
    const { status, json } = await send(request('ping'), { headers: { origin: 'https://evil.example' } })
    expect(status).toBe(403)
    expect(json.error?.message).toMatch(/origin/i)
  })

  it('allows the deployment’s own Origin', async () => {
    const { status } = await send(request('ping'), { headers: { origin: 'https://lamitja.example' } })
    expect(status).toBe(200)
  })

  it('allows an absent Origin, which is what every CLI client sends', async () => {
    expect((await send(request('ping'))).status).toBe(200)
  })
})

describe('bearer auth', () => {
  it('rejects a wrong token with 401 and a challenge', async () => {
    const { status, response, json } = await send(request('tools/list'), { auth: 'hunter2' })
    expect(status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(json.error?.code).toBe(RPC.UNAUTHORIZED)
  })

  it('rejects a missing Authorization header', async () => {
    const { status, response } = await send(request('tools/list'), { auth: null })
    expect(status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('rejects a token of the right length but the wrong bytes', async () => {
    const wrong = 'x'.repeat(SECRET.length)
    expect((await send(request('tools/list'), { auth: wrong })).status).toBe(401)
  })

  it('rejects another scheme carrying the right secret', async () => {
    const response = await handleMcp(
      new Request(URL_, {
        method: 'POST',
        headers: { authorization: `Basic ${SECRET}` },
        body: JSON.stringify(request('ping')),
      }),
      stubRegistry(),
    )
    expect(response.status).toBe(401)
  })

  it('refuses a token that belongs to no athlete', async () => {
    // The multi-athlete shape of "wrong password": `resolve` finds nobody, and the request
    // is refused before its body is read. There is no deployment-wide secret to be unset.
    const response = await handleMcp(post(request('ping'), { auth: 'not-anybodys-token' }), {
      ...stubRegistry(),
      resolve: async () => null,
    })
    expect(response.status).toBe(401)
  })

  it('never hands out a registry it could not attribute', async () => {
    // The guarantee `resolve` exists to give: no token, no tools. If this ever passes with
    // a null resolution, some path is building an unscoped registry.
    let built = false
    const response = await handleMcp(post(request('tools/list'), { auth: 'guess' }), {
      ...stubRegistry(),
      resolve: async () => {
        built = true
        return null
      },
    })
    expect(built).toBe(true)
    expect(response.status).toBe(401)
    expect(await response.clone().json()).toMatchObject({ error: { code: RPC.UNAUTHORIZED } })
  })
})

// ---------------------------------------------------------------------------
// Legacy era
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('echoes back a version we support', async () => {
    for (const version of PROTOCOL_VERSIONS) {
      const { json } = await send(request('initialize', { protocolVersion: version }))
      expect(json.result?.protocolVersion).toBe(version)
    }
  })

  it('falls back to the newest for a version it has never heard of', async () => {
    const { json } = await send(request('initialize', { protocolVersion: '2024-11-05' }))
    expect(json.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('advertises tools, itself and its instructions', async () => {
    const { json } = await send(request('initialize', { protocolVersion: '2025-06-18' }))
    expect(json.result?.capabilities).toEqual({ tools: {} })
    expect(json.result?.serverInfo).toEqual({ name: 'test-server', version: '9.9.9' })
    expect(json.result?.instructions).toBe('Call get_block first.')
  })

  it('never mints a session id', async () => {
    const { response } = await send(request('initialize', { protocolVersion: '2025-06-18' }))
    expect(response.headers.get('mcp-session-id')).toBeNull()
  })
})

describe('notifications', () => {
  it('answers a message with no id with an empty 202', async () => {
    const response = await handleMcp(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      stubRegistry(),
    )
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('treats an explicit null id as a request, not a notification', async () => {
    const { status, json } = await send({ jsonrpc: '2.0', id: null, method: 'ping' })
    expect(status).toBe(200)
    expect(json.result).toEqual({})
  })
})

describe('ping', () => {
  it('answers with an empty result', async () => {
    const { json } = await send(request('ping'))
    expect(json).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('tools/list', () => {
  it('returns every tool with a name, a description and a schema', async () => {
    const { status, json } = await send(request('tools/list'))
    expect(status).toBe(200)

    const tools = json.result?.tools as { name: string; description: string; inputSchema: unknown }[]
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'boom', 'throws'])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeTypeOf('object')
    }
  })

  it('works from a bare request with no protocol version anywhere', async () => {
    const response = await handleMcp(
      new Request(URL_, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(request('tools/list')),
      }),
      stubRegistry(),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('tools/call', () => {
  it('returns the tool’s content on success', async () => {
    const { status, json } = await send(request('tools/call', { name: 'echo', arguments: { weekIndex: 3 } }))
    expect(status).toBe(200)
    expect(json.result?.content).toEqual([{ type: 'text', text: '{"weekIndex":3}' }])
    expect(json.result?.isError).toBeUndefined()
  })

  it('carries a tool failure as isError, not as a transport error', async () => {
    const { status, json } = await send(request('tools/call', { name: 'boom' }))
    expect(status).toBe(200)
    expect(json.result?.isError).toBe(true)
    expect(json.result?.content).toEqual([{ type: 'text', text: 'row 3 is invalid' }])
  })

  it('turns a thrown handler into isError as well', async () => {
    const { status, json } = await send(request('tools/call', { name: 'throws' }))
    expect(status).toBe(200)
    expect(json.result?.isError).toBe(true)
    expect(JSON.stringify(json.result?.content)).toContain('handler exploded')
  })

  it('rejects an unknown tool with invalid params', async () => {
    const { json } = await send(request('tools/call', { name: 'nope' }))
    expect(json.error?.code).toBe(RPC.INVALID_PARAMS)
    expect(json.error?.message).toContain('tools/list')
  })

  it('rejects a call with no name', async () => {
    const { json } = await send(request('tools/call', {}))
    expect(json.error?.code).toBe(RPC.INVALID_PARAMS)
  })
})

// ---------------------------------------------------------------------------
// Modern era
// ---------------------------------------------------------------------------

describe('server/discover', () => {
  it('returns the whole surface in one round trip', async () => {
    const { body, options } = modern('server/discover')
    const { status, json } = await send(body, options)

    expect(status).toBe(200)
    expect(json.result?.resultType).toBe('complete')
    expect(json.result?.supportedVersions).toEqual([...PROTOCOL_VERSIONS])
    expect(json.result?.capabilities).toEqual({ tools: {} })
    expect(json.result?.instructions).toBe('Call get_block first.')
    expect(json.result?._meta).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: 'test-server', version: '9.9.9' },
    })
  })

  it('is served to a legacy caller too, so a bare curl can discover the server', async () => {
    const { json } = await send(request('server/discover'))
    expect(json.result?.resultType).toBe('complete')
  })
})

describe('protocol versions', () => {
  it('rejects an unsupported version in the header, and says which it speaks', async () => {
    const { status, json } = await send(request('tools/list'), {
      headers: { 'mcp-protocol-version': '2024-11-05' },
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.UNSUPPORTED_VERSION)
    expect(json.error?.message).toBe('Unsupported protocol version')
    expect(json.error?.data).toEqual({ supported: [...PROTOCOL_VERSIONS], requested: '2024-11-05' })
  })

  it('rejects an unsupported version in params._meta as well', async () => {
    const { status, json } = await send(
      request('tools/list', { _meta: { [VERSION_META]: '2027-01-01' } }),
    )
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.UNSUPPORTED_VERSION)
    expect(json.error?.data?.requested).toBe('2027-01-01')
  })

  it('accepts every version it advertises', async () => {
    for (const version of PROTOCOL_VERSIONS) {
      const { status } = await send(request('tools/list'), {
        headers: { 'mcp-protocol-version': version },
      })
      expect(status).toBe(200)
    }
  })
})

describe('mirrored headers', () => {
  it('rejects a version header that disagrees with the body', async () => {
    const { status, json } = await send(
      request('tools/list', { _meta: { [VERSION_META]: '2025-06-18' } }),
      { headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } },
    )
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.HEADER_MISMATCH)
    expect(json.error?.message).toContain('MCP-Protocol-Version')
  })

  it('rejects an Mcp-Method header that disagrees with the body', async () => {
    const { status, json } = await send(request('ping'), { headers: { 'mcp-method': 'tools/list' } })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.HEADER_MISMATCH)
    expect(json.error?.message).toContain('Mcp-Method')
  })

  it('rejects an Mcp-Name header that disagrees with the tool being called', async () => {
    const { status, json } = await send(request('tools/call', { name: 'echo' }), {
      headers: { 'mcp-name': 'boom' },
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.HEADER_MISMATCH)
    expect(json.error?.message).toContain('Mcp-Name')
  })

  it('accepts headers that agree', async () => {
    const { status } = await send(request('tools/call', { name: 'echo', arguments: {} }), {
      headers: { 'mcp-method': 'tools/call', 'mcp-name': 'echo' },
    })
    expect(status).toBe(200)
  })
})

describe('unknown methods', () => {
  it('answers 404 with -32601 in the modern era', async () => {
    const { body, options } = modern('resources/list')
    const { status, json } = await send(body, options)
    expect(status).toBe(404)
    expect(json.error?.code).toBe(RPC.METHOD_NOT_FOUND)
    expect(json.jsonrpc).toBe('2.0')
  })

  it('answers 200 with -32601 in the legacy era, where the SDK reads errors from the body', async () => {
    const { status, json } = await send(request('resources/list'))
    expect(status).toBe(200)
    expect(json.error?.code).toBe(RPC.METHOD_NOT_FOUND)
  })
})

describe('malformed input', () => {
  it('answers a body that is not JSON with -32700', async () => {
    const { status, json } = await send('{ not json')
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.PARSE_ERROR)
  })

  it('rejects a JSON-RPC batch — batching was removed and never came back', async () => {
    const { status, json } = await send([request('ping')])
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.INVALID_REQUEST)
  })

  it('rejects a message with no method', async () => {
    const { status, json } = await send({ jsonrpc: '2.0', id: 7 })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(RPC.INVALID_REQUEST)
    expect(json.id).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// The boundary conversions
// ---------------------------------------------------------------------------

describe('ISO dates', () => {
  it('writes a stored wall clock as YYYY-MM-DD', () => {
    expect(toIsoDate(BLOCK.startsOn)).toBe('2026-08-17')
    expect(toIsoDate(BLOCK.raceOn)).toBe('2027-01-24')
    // Any time of day on a stored date still names that date.
    expect(toIsoDate(BLOCK.startsOn + 23 * 3_600_000)).toBe('2026-08-17')
  })

  it('reads YYYY-MM-DD back as UTC midnight, which is the scale everything is stored on', () => {
    expect(fromIsoDate('2026-08-17')).toBe(BLOCK.startsOn)
    expect(fromIsoDate(' 2027-01-24 ')).toBe(BLOCK.raceOn)
    expect(toIsoDate(fromIsoDate('2026-12-31'))).toBe('2026-12-31')
  })

  it('rejects anything that is not a date', () => {
    for (const bad of ['', '17/08/2026', '2026-8-17', '2026-08-17T00:00:00Z', 'tomorrow', '20260817']) {
      expect(() => fromIsoDate(bad)).toThrow()
    }
  })

  it('rejects a date that does not exist, rather than rolling it forward', () => {
    // Date.UTC would answer 2 March here, and a session silently moved thirteen days is
    // worse than an error.
    expect(() => fromIsoDate('2026-02-30')).toThrow()
    expect(() => fromIsoDate('2026-13-01')).toThrow()
    expect(() => fromIsoDate('2026-00-10')).toThrow()
  })
})

describe('mm:ss paces', () => {
  it('round-trips against the app’s own formatter', () => {
    expect(toPace(227)).toBe('3:47')
    expect(fromPace('3:47')).toBe(227)
    for (const zone of PACE_ZONES) {
      expect(fromPace(toPace(CTX.bands[zone].lo))).toBe(Math.round(CTX.bands[zone].lo))
    }
  })

  it('rejects anything that is not mm:ss, so a typo never saves as zero', () => {
    for (const bad of ['', '3.47', '3:60', '227', 'fast', '3:7']) {
      expect(() => fromPace(bad)).toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// The tools themselves
// ---------------------------------------------------------------------------

/** Every tool below is one that never reaches the database on the path being tested. */
const CTX = {
  db: null as unknown as Database,
  userId: 'test-athlete',
  block: BLOCK,
  hrMax: DEFAULT_HR_MAX,
  bands: paceBands(goalPaceSKm(BLOCK)),
}
const registry = () => createToolRegistry(CTX)

const resultOf = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await registry().call(name, args)
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') }
}

describe('withDerivedDistance', () => {
  // The column every screen sums and the matcher measures against. A session written
  // with steps and no stored distance is invisible to the week bars — the bug this
  // guards against shipped: create_sessions stored `targetDistanceM: null` for every
  // steps-carrying session while its own schema told the agent not to send the field.
  const steps = [
    { kind: 'warmup', reps: 1, distanceM: 2500, durationS: null, zone: 'easy', recovery: null, note: null },
    { kind: 'strides', reps: 4, distanceM: null, durationS: 20, zone: null, recovery: null, note: null },
    { kind: 'rep', reps: 20, distanceM: 400, durationS: null, zone: 'vo2', recovery: { kind: 'jog', distanceM: 200, durationS: null }, note: null },
    { kind: 'cooldown', reps: 1, distanceM: 1500, durationS: null, zone: 'easy', recovery: null, note: null },
  ] as const

  it('stores the sum of the steps, recovery jogs included', () => {
    const data = withDerivedDistance({ type: 'interval', steps, targetDistanceM: null }, CTX.bands)
    // 2500 + 4×20s×5m/s + 20×400 + 19×200 + 1500
    expect(data.targetDistanceM).toBe(16200)
  })

  it('costs a timed step at the athlete’s own bands, not the owner’s', () => {
    const timed = [{ kind: 'steady', reps: 1, distanceM: null, durationS: 600, zone: 'easy', recovery: null, note: null }]
    const slower = paceBands(300) // a 5:00/km goal — easy band far slower than the owner's
    const own = withDerivedDistance({ type: 'easy', steps: timed }, CTX.bands)
    const other = withDerivedDistance({ type: 'easy', steps: timed }, slower)
    expect(own.targetDistanceM).not.toBe(other.targetDistanceM)
  })

  it('leaves a session without steps alone — explicit null included', () => {
    expect(withDerivedDistance({ type: 'easy', targetDistanceM: 5000 }, CTX.bands).targetDistanceM).toBe(5000)
    expect(withDerivedDistance({ type: 'easy', steps: null, targetDistanceM: 5000 }, CTX.bands).targetDistanceM).toBe(5000)
  })

  it('never puts a distance on a session that does not count as volume', () => {
    const data = withDerivedDistance({ type: 'strength', steps, targetDistanceM: null }, CTX.bands)
    expect(data.targetDistanceM).toBeNull()
  })
})

describe('the registry', () => {
  it('advertises unique, described, schema-carrying tools', () => {
    const tools = registry().list()
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length)

    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/)
      // The description is the interface here: a model picks a tool by reading it.
      expect(tool.description.length).toBeGreaterThan(80)
      expect((tool.inputSchema as { type: string }).type).toBe('object')
    }
  })

  it('covers reading the block and writing to it', () => {
    expect(registry().list().map((t) => t.name)).toEqual([
      'get_block',
      'list_weeks',
      'list_sessions',
      'list_activities',
      'get_training_summary',
      'upsert_week',
      'create_session',
      'create_sessions',
      'update_session',
      'delete_session',
      'search_exercises',
      'get_exercise',
      'list_templates',
      'create_template',
      'update_template',
      'delete_template',
      'attach_template',
    ])
  })

  it('tells the agent how to approach a plan', () => {
    const instructions = SERVER_INSTRUCTIONS
    expect(instructions).toContain('get_block')
    expect(instructions).toContain('steps')
    expect(instructions).toMatch(/consecutive days/)
  })

  it('tells the agent how to approach a strength day, and in which language to write it', () => {
    expect(SERVER_INSTRUCTIONS).toContain('attach_template')
    expect(SERVER_INSTRUCTIONS).toContain('search_exercises')
    // The whole point of the copy, stated where an agent will read it before it revises a
    // template and expects last month's Mondays to follow.
    expect(SERVER_INSTRUCTIONS).toMatch(/COPIES it onto the session|copied onto the session|COPIES/i)
    expect(SERVER_INSTRUCTIONS).toMatch(/Spanish/)
  })

  it('offers `steps` as a union rather than as an array, and assembles it from the registry', () => {
    const create = registry().list().find((tool) => tool.name === 'create_session')
    const steps = (create!.inputSchema as { properties: { steps: Record<string, unknown> } })
      .properties.steps

    // Both arms, in PRESCRIPTION_KINDS order — the run one first, because every row ever
    // written is one and its prose has to keep reading the way it always did.
    expect(steps.type).toEqual(['array', 'object', 'null'])
    const arms = steps.oneOf as { type: string }[]
    expect(arms.map((arm) => arm.type)).toEqual(['array', 'object'])
    expect(JSON.stringify(arms[1])).toContain('"strength"')
  })
})

describe('get_block', () => {
  /**
   * The brief is a *view* of the app's own constants, never a second copy of them. If this
   * ever stops matching, the MCP surface has started telling agents a different training
   * plan from the one the app is running.
   */
  it('reports exactly the block the rest of the app is built on', () => {
    const brief = blockBrief(CTX, Date.UTC(2026, 7, 26))

    expect(brief.race.name).toBe(BLOCK.raceName)
    expect(brief.race.place).toBe(BLOCK.racePlace)
    expect(brief.race.date).toBe(toIsoDate(BLOCK.raceOn))
    expect(brief.block.startsOn).toBe(toIsoDate(BLOCK.startsOn))
    expect(brief.block.totalWeeks).toBe(totalWeeks(BLOCK))
    expect(brief.goal.timeS).toBe(BLOCK.goalTimeS)
    expect(brief.today).toEqual({ date: '2026-08-26', weekIndex: 1 })

    expect(brief.paceZones.map((band) => band.zone)).toEqual([...PACE_ZONES])
    for (const band of brief.paceZones) {
      expect(band.loSKm).toBe(CTX.bands[band.zone].lo)
      expect(band.hiSKm).toBe(CTX.bands[band.zone].hi)
    }
    expect(brief.sessionTypes.map((type) => type.type)).toEqual([...SESSION_TYPES])
  })

  it('describes each kind of prescription from the strategy that owns it, never a second copy', () => {
    const brief = blockBrief(CTX, Date.UTC(2026, 7, 26))

    // Same rule as the pace zones above: the brief is a *view*. If these stop matching, the
    // MCP surface has begun telling agents a different shape from the one the app stores.
    expect(Object.keys(brief.prescriptions)).toEqual([...PRESCRIPTION_KINDS])
    for (const kind of PRESCRIPTION_KINDS) {
      expect(brief.prescriptions[kind]).toBe(STRATEGIES[kind].authoring.brief)
    }

    // And which type takes which, so an agent never has to guess that a Fuerza day is not
    // a list of running steps.
    const byType = new Map(brief.sessionTypes.map((row) => [row.type, row.prescribes]))
    expect(byType.get('easy')).toBe('run')
    expect(byType.get('strength')).toBe('strength')
    expect(byType.get('rest')).toBeNull()
  })

  it('answers without touching the database', async () => {
    const { isError, text } = await resultOf('get_block')
    expect(isError).toBe(false)
    expect(JSON.parse(text).block.totalWeeks).toBe(totalWeeks(BLOCK))
  })
})

describe('write validation happens before the database does', () => {
  it('reports a malformed date as an actionable result', async () => {
    const { isError, text } = await resultOf('create_session', {
      scheduledOn: '17/08/2026',
      type: 'easy',
      title: 'Rodaje',
    })
    expect(isError).toBe(true)
    expect(text).toContain('scheduledOn')
    expect(text).toContain('YYYY-MM-DD')
  })

  it('refuses a session outside the block, using the app’s own validator', async () => {
    const { isError, text } = await resultOf('create_session', {
      scheduledOn: '2025-01-01',
      type: 'easy',
      title: 'Rodaje',
    })
    expect(isError).toBe(true)
    expect(text).toContain('bloque')
  })

  it('refuses a pace that is not mm:ss', async () => {
    const { isError, text } = await resultOf('create_session', {
      scheduledOn: toIsoDate(BLOCK.startsOn),
      type: 'easy',
      title: 'Rodaje',
      targetPaceLo: '5.00',
    })
    expect(isError).toBe(true)
    expect(text).toContain('targetPaceLo')
  })

  it('names the failing rows of a batch by index and writes none of them', async () => {
    const { isError, text } = await resultOf('create_sessions', {
      sessions: [
        { id: 'w00-mon-0', scheduledOn: toIsoDate(BLOCK.startsOn), type: 'easy', title: 'Rodaje' },
        { id: 'w00-tue-0', scheduledOn: 'nope', type: 'easy', title: 'Rodaje' },
        { id: 'w00-wed-0', scheduledOn: toIsoDate(BLOCK.startsOn), type: 'flying', title: 'Rodaje' },
      ],
    })
    expect(isError).toBe(true)
    expect(text).toContain('nothing was written')

    const details = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { index: number }[]
    expect(details.map((failure) => failure.index)).toEqual([1, 2])
  })

  it('refuses a batch that would write the same id twice', async () => {
    const day = toIsoDate(BLOCK.startsOn)
    const { isError, text } = await resultOf('create_sessions', {
      sessions: [
        { id: 'w00-mon-0', scheduledOn: day, type: 'easy', title: 'Rodaje' },
        { id: 'w00-mon-0', scheduledOn: day, type: 'strength', title: 'Fuerza' },
      ],
    })
    expect(isError).toBe(true)
    expect(text).toContain('duplicate id')
  })

  it('fills a step’s blanks, so only kind and the numbers that matter have to be written', async () => {
    const { isError, text } = await resultOf('create_session', {
      // Everything here is valid except the date, which is the only issue that should
      // come back — if the steps needed their nulls spelled out, they would fail too.
      scheduledOn: '2020-01-01',
      type: 'interval',
      title: 'Series',
      steps: [
        { kind: 'warmup', distanceM: 3000, zone: 'easy' },
        { kind: 'rep', reps: 5, distanceM: 1000, zone: 'vo2', recovery: { kind: 'jog', durationS: 90 } },
        { kind: 'cooldown', distanceM: 2000 },
      ],
    })
    expect(isError).toBe(true)

    const issues = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { path: string }[]
    expect(issues.map((issue) => issue.path)).toEqual(['scheduledOn'])
  })

  it('refuses a patch that changes nothing', async () => {
    const { isError } = await resultOf('update_session', { id: 'w03-tue-1' })
    expect(isError).toBe(true)
  })

  it('refuses a week index outside the block', async () => {
    const { isError, text } = await resultOf('upsert_week', { weekIndex: totalWeeks(BLOCK), phase: 'Base' })
    expect(isError).toBe(true)
    expect(text).toContain('weekIndex')
  })
})

// ---------------------------------------------------------------------------
// The exercise catalogue and the template library
// ---------------------------------------------------------------------------

/**
 * Everything below runs with `CTX.db` null, so every assertion is about a path that
 * refuses *before* it would reach the database. That is the shape the tests want anyway:
 * a write that is rejected after touching D1 is a write that half happened.
 */

/** What an agent writes: two moves, one measured in repetitions and one in seconds. */
const STRENGTH_STEPS = {
  kind: 'strength',
  exercises: [
    { exerciseId: 'plank', name: 'Plancha', sets: 3, durationS: 40, restS: 30 },
    { exerciseId: 'glute-bridge', name: 'Puente de Glúteos', sets: 2, reps: 15, restS: 30 },
  ],
}

describe('search_exercises', () => {
  it('answers without touching the database, in Spanish and in English alike', async () => {
    for (const q of ['plancha lateral', 'side plank', 'side-plank']) {
      const { isError, text } = await resultOf('search_exercises', { q })
      expect(isError, q).toBe(false)
      expect(JSON.parse(text).results.map((hit: { id: string }) => hit.id)).toContain('side-plank')
    }
  })

  it('carries the tags, because that is what a rebuild filters on', async () => {
    const { text } = await resultOf('search_exercises', { tags: ['knee_safe'], limit: 5 })
    const results = JSON.parse(text).results as { tags: string[]; name: string }[]
    expect(results.length).toBeGreaterThan(0)
    for (const hit of results) expect(hit.tags).toContain('knee_safe')
    // The Spanish name is what a prescription must copy, so it has to be on the hit.
    for (const hit of results) expect(hit.name).not.toBe('')
  })

  it('reads equipment "none" as bodyweight rather than as a slug', async () => {
    const { text } = await resultOf('search_exercises', { equipment: 'none', limit: 5 })
    const results = JSON.parse(text).results as { equipment: string | null }[]
    expect(results.length).toBeGreaterThan(0)
    for (const hit of results) expect(hit.equipment).toBeNull()
  })

  it('names a facet it does not know instead of answering with an empty list', async () => {
    // An empty result reads as "there is no such exercise", which is the wrong conclusion
    // to hand a model — so a typo comes back as an error carrying the valid values.
    const { isError, text } = await resultOf('search_exercises', { muscle: 'glutes' })
    expect(isError).toBe(true)
    expect(text).toContain('muscle')
    expect(text).toContain('gluteus_maximus')
  })

  it('caps the result set, so this is a search and never a listing', async () => {
    const { isError, text } = await resultOf('search_exercises', { limit: 500 })
    expect(isError).toBe(true)
    expect(text).toContain('limit')
  })
})

describe('get_exercise', () => {
  it('returns the Spanish record for a known id', async () => {
    const { isError, text } = await resultOf('get_exercise', { id: 'plank' })
    expect(isError).toBe(false)
    const exercise = JSON.parse(text) as { name: string; instructions: string[] }
    expect(exercise.name).toBe('Plancha')
    expect(exercise.instructions.length).toBeGreaterThan(0)
  })

  it('refuses an id the catalogue does not have', async () => {
    const { isError, text } = await resultOf('get_exercise', { id: 'copenhagen-plank' })
    expect(isError).toBe(true)
    expect(text).toContain('search_exercises')
  })
})

describe('template writes validate before the database does', () => {
  it('names an exercise id the catalogue does not have, by its index, and writes nothing', async () => {
    const { isError, text } = await resultOf('create_template', {
      id: 'fuerza-lunes',
      name: 'Fuerza de lunes',
      exercises: [
        { exerciseId: 'plank', name: 'Plancha', sets: 3, durationS: 40 },
        { exerciseId: 'copenhagen-plank', name: 'Plancha de aductores', sets: 3, durationS: 30 },
      ],
    })
    expect(isError).toBe(true)
    expect(text).toContain('nothing was written')

    const issues = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { path: string }[]
    expect(issues.map((issue) => issue.path)).toEqual(['exercises.1.exerciseId'])
  })

  it('lets a written-in move through — a null id is a prescription, not a typo', async () => {
    // The physio's own cue outranks whatever RepDB files it under, so this has to reach
    // the database rather than be refused. `CTX.db` is null, so reaching it is the proof.
    const { isError, text } = await resultOf('create_template', {
      name: 'Fuerza de lunes',
      exercises: [{ name: 'Almejas (banda media)', sets: 2, reps: 15 }],
    })
    expect(isError).toBe(true)
    expect(text).not.toContain('nothing was written')
  })

  it('insists an exercise is measured in repetitions or in seconds, never both', async () => {
    const { isError, text } = await resultOf('create_template', {
      name: 'Fuerza de lunes',
      exercises: [{ exerciseId: 'plank', name: 'Plancha', sets: 3, reps: 10, durationS: 40 }],
    })
    expect(isError).toBe(true)
    expect(text).toContain('repeticiones o segundos')
  })

  it('refuses the ids that belong to the templates shipping with the app', async () => {
    for (const tool of ['create_template', 'update_template', 'delete_template']) {
      const { isError, text } = await resultOf(tool, {
        id: 'treximo-core',
        name: 'Mío',
        exercises: [{ exerciseId: 'plank', name: 'Plancha', sets: 3, durationS: 40 }],
      })
      expect(isError, tool).toBe(true)
      expect(text, tool).toContain('treximo-')
    }
  })
})

describe('attach_template', () => {
  it('insists on exactly one of a day and a session', async () => {
    const day = toIsoDate(BLOCK.startsOn)
    for (const args of [
      { templateId: 'treximo-core' },
      { templateId: 'treximo-core', scheduledOn: day, sessionId: 'w00-mon-0' },
    ]) {
      const { isError, text } = await resultOf('attach_template', args)
      expect(isError).toBe(true)
      expect(text).toContain('exactly one')
    }
  })

  it('resolves a built-in without a database and runs the copy through the session schema', async () => {
    // Outside the block, so the only thing that can answer is the app's own validator —
    // which means the built-in was found and composed into a session before it got there.
    const { isError, text } = await resultOf('attach_template', {
      templateId: 'treximo-rodilla-caderas',
      scheduledOn: '2025-01-01',
    })
    expect(isError).toBe(true)
    expect(text).toContain('bloque')
  })

  it('clears the distance it is covering, so no run’s metres survive under a list of planks', () => {
    const stamped = sessionFromTemplate(BUILTIN_TEMPLATES[0])
    expect(stamped.targetDistanceM).toBeNull()
    expect(stamped.targetDurationS).toBe(2100)
    expect(stamped.steps.kind).toBe('strength')
    // The title comes from the template, which is what makes the copy legible on the card.
    expect(stamped.title).toBe(BUILTIN_TEMPLATES[0].name)
  })

  it('refuses to stamp a template onto a running day', async () => {
    const { isError, text } = await resultOf('attach_template', {
      templateId: 'treximo-core',
      scheduledOn: toIsoDate(BLOCK.startsOn),
      type: 'tempo',
    })
    expect(isError).toBe(true)
    expect(text).toContain('tempo')
  })
})

describe('a strength prescription on a session', () => {
  it('derives no distance from a list of planks', () => {
    // `workoutDistanceM` on a list of holds is not a smaller number, it is a wrong one —
    // and a strength day is measured in the minutes the session states, never in metres.
    const data = withDerivedDistance({ type: 'strength', steps: STRENGTH_STEPS }, CTX.bands)
    expect(data.targetDistanceM).toBeUndefined()
    expect(data.steps).toBe(STRENGTH_STEPS)
  })

  it('validates row by row in a batch, and a good strength row passes', async () => {
    const day = toIsoDate(BLOCK.startsOn)
    const { isError, text } = await resultOf('create_sessions', {
      sessions: [
        { id: 'w00-mon-0', scheduledOn: day, type: 'strength', title: 'Fuerza', steps: STRENGTH_STEPS },
        {
          id: 'w00-wed-0',
          scheduledOn: day,
          type: 'strength',
          title: 'Fuerza',
          steps: {
            kind: 'strength',
            exercises: [{ exerciseId: 'no-such-move', name: 'Inventado', sets: 3, reps: 10 }],
          },
        },
      ],
    })
    expect(isError).toBe(true)

    const failures = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      index: number
      issues: { path: string }[]
    }[]
    // Only the second row: the first one's strength payload is valid, which is the half of
    // this assertion that is easy to lose.
    expect(failures.map((failure) => failure.index)).toEqual([1])
    expect(failures[0].issues.map((issue) => issue.path)).toEqual(['steps.exercises.0.exerciseId'])
  })

  it('still reports a bad step array at the step that is bad', async () => {
    // The union must not swallow the array arm's own paths — `steps: Invalid input` is
    // what the plan editor renders when it does, and it is what this guards against.
    const { isError, text } = await resultOf('create_session', {
      scheduledOn: toIsoDate(BLOCK.startsOn),
      type: 'interval',
      title: 'Series',
      steps: [{ kind: 'warmup', distanceM: 3000 }, { kind: 'sprint', distanceM: 400 }],
    })
    expect(isError).toBe(true)

    const issues = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { path: string }[]
    expect(issues.map((issue) => issue.path)).toEqual(['steps.1.kind'])
  })
})

/**
 * The speed bump in front of the bearer check.
 *
 * The endpoint is one token, the URL is in a public repository, and until this existed a
 * guesser was limited by nothing but their own bandwidth. What matters here is the
 * *order*: the limiter is consulted before the credential, because one consulted after it
 * throttles the status code and not the guessing.
 */
describe('mcp · rate limiting', () => {
  const limited = (): McpServer => ({ ...stubRegistry(), withinLimit: async () => false })

  it('turns away a caller over the limit, with 429 rather than 401', async () => {
    const response = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), limited())
    expect(response.status).toBe(429)
  })

  it('refuses the correct token too, which is what makes it a limit at all', async () => {
    // The whole point. If a valid bearer walked past the limiter, an attacker's guesses
    // would still every one of them be checked, and the throttle would protect nothing
    // but the status code they got back.
    const response = await handleMcp(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: SECRET }),
      limited(),
    )
    expect(response.status).toBe(429)
  })

  it('refuses a wrong token with 429, not 401', async () => {
    const response = await handleMcp(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: 'guess' }),
      limited(),
    )
    expect(response.status).toBe(429)
  })

  it('turns the request away before parsing its body', async () => {
    // Malformed JSON would be `-32700` at 400 if the body were read first. Getting 429
    // proves the limiter ran ahead of it — a request being refused costs no parsing.
    const response = await handleMcp(post('{ not json', { auth: SECRET }), limited())
    expect(response.status).toBe(429)
  })

  it('lets everything through when no limiter is configured', async () => {
    // A fork that dropped the binding, or local `wrangler dev`. No limiting beats no app:
    // the credential check behind it is still there either way.
    const { serverInfo, instructions, resolve } = stubRegistry()
    const response = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      serverInfo,
      instructions,
      resolve,
    })
    expect(response.status).toBe(200)
  })

  it('is checked after the origin, so a cross-origin caller cannot spend the budget', async () => {
    let consulted = false
    const server: McpServer = {
      ...stubRegistry(),
      withinLimit: async () => {
        consulted = true
        return true
      },
    }
    const response = await handleMcp(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
        headers: { origin: 'https://evil.example' },
      }),
      server,
    )
    expect(response.status).toBe(403)
    expect(consulted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * Every database statement in `tools.ts` must name the athlete.
 *
 * This reads the shipped source rather than exercising a database, which is unusual and is
 * the point: the bug it exists to catch does not throw, does not fail a type check and
 * does not show up in any single-athlete test. A `where(eq(planSessions.id, id))` looks
 * completely correct — `id` reads like a primary key — right up until a second athlete
 * exists, at which point one agent silently rewrites another's plan. That is exactly what
 * happened here: `update_session` and `delete_session` both shipped unscoped through a
 * type check, a full unit suite and a build, and were only caught by two accounts and a
 * curl.
 *
 * A real fixture would be better and needs a SQLite dependency this project does not carry
 * for one test. Reading the source is the cheap version of the same guarantee, and it fails
 * loudly the moment somebody adds a query and forgets — which is the whole failure mode.
 */
describe('tenancy · every query is scoped to one athlete', () => {
  it('names userId in every database statement in tools.ts', async () => {
    const source = await import('../../src/lib/mcp/tools.ts?raw').then((m) => m.default as string)

    // Each statement runs from `db` up to the call that ends it.
    const statements = source.match(/\bdb\s*\n?\s*\.(select|insert|update|delete)\b[\s\S]*?(?=\n\n|\n\s{0,6}\breturn\b|\n\s{0,6}\})/g)
    expect(statements, 'no db statements found — has tools.ts moved?').toBeTruthy()
    expect(statements!.length).toBeGreaterThan(5)

    const unscoped = statements!.filter((statement) => !statement.includes('userId'))
    expect(unscoped.map((s) => s.replace(/\s+/g, ' ').slice(0, 100))).toEqual([])
  })

  it('never keys an upsert on a bare id or week index', async () => {
    // The primary keys are composite. A conflict target of `planSessions.id` alone either
    // errors (no matching constraint) or, worse, would match across athletes.
    const source = await import('../../src/lib/mcp/tools.ts?raw').then((m) => m.default as string)
    expect(source).not.toMatch(/target:\s*planSessions\.id\b/)
    expect(source).not.toMatch(/target:\s*planWeeks\.weekIndex\b/)
    // `workout_templates` is keyed the same way and for exactly the same reason: an id like
    // `fuerza-lunes` is a slug two athletes will both pick.
    expect(source).not.toMatch(/target:\s*workoutTemplates\.id\b/)
  })

  it('filters every template statement on the template table’s own userId column', async () => {
    // Stronger than the scan above, and deliberately so. That one asks whether the word
    // `userId` appears anywhere in the statement, which a statement filtering some *other*
    // table by it would satisfy. This asks the question that actually matters for the
    // newest table: is this athlete's column the one in the where clause.
    const source = await import('../../src/lib/mcp/tools.ts?raw').then((m) => m.default as string)

    const statements = source.match(
      /\bdb\s*\n?\s*\.(select|insert|update|delete)\b[\s\S]*?(?=\n\n|\n\s{0,6}\breturn\b|\n\s{0,6}\})/g,
    )!
    const templateStatements = statements.filter((s) => s.includes('workoutTemplates'))
    expect(templateStatements.length).toBeGreaterThanOrEqual(4)

    const unscoped = templateStatements.filter((s) => !s.includes('workoutTemplates.userId'))
    expect(unscoped.map((s) => s.replace(/\s+/g, ' ').slice(0, 100))).toEqual([])
  })
})
