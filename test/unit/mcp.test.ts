import { describe, expect, it } from 'vitest'
import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  RPC,
  handleMcp,
  type ToolRegistry,
} from '@/lib/mcp/protocol'
import {
  blockBrief,
  createToolRegistry,
  fromIsoDate,
  fromPace,
  toIsoDate,
  toPace,
} from '@/lib/mcp/tools'
import { BLOCK_START, GOAL_TIME_S, RACE_DATE, TOTAL_WEEKS } from '@/lib/block'
import { PACES, PACE_ZONES } from '@/lib/paces'
import { SESSION_TYPES } from '@/lib/plan'
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

function stubRegistry(): ToolRegistry {
  return {
    serverInfo: { name: 'test-server', version: '9.9.9' },
    instructions: 'Call get_block first.',
    secret: SECRET,
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

  it('refuses to serve anything when the deployment has no password set', async () => {
    const response = await handleMcp(post(request('ping')), { ...stubRegistry(), secret: '' })
    expect(response.status).toBe(500)
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
    expect(toIsoDate(BLOCK_START)).toBe('2026-08-17')
    expect(toIsoDate(RACE_DATE)).toBe('2027-01-24')
    // Any time of day on a stored date still names that date.
    expect(toIsoDate(BLOCK_START + 23 * 3_600_000)).toBe('2026-08-17')
  })

  it('reads YYYY-MM-DD back as UTC midnight, which is the scale everything is stored on', () => {
    expect(fromIsoDate('2026-08-17')).toBe(BLOCK_START)
    expect(fromIsoDate(' 2027-01-24 ')).toBe(RACE_DATE)
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
      expect(fromPace(toPace(PACES[zone].lo))).toBe(Math.round(PACES[zone].lo))
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
const registry = () => createToolRegistry(null as unknown as Database, SECRET)

const resultOf = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await registry().call(name, args)
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') }
}

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
      'seed_plan',
    ])
  })

  it('tells the agent how to approach a plan', () => {
    const { instructions } = registry()
    expect(instructions).toContain('get_block')
    expect(instructions).toContain('steps')
    expect(instructions).toMatch(/consecutive days/)
  })
})

describe('get_block', () => {
  /**
   * The brief is a *view* of the app's own constants, never a second copy of them. If this
   * ever stops matching, the MCP surface has started telling agents a different training
   * plan from the one the app is running.
   */
  it('reports exactly the block the rest of the app is built on', () => {
    const brief = blockBrief(Date.UTC(2026, 7, 26), 'Test Race')

    expect(brief.race.name).toBe('Test Race')
    expect(brief.race.date).toBe(toIsoDate(RACE_DATE))
    expect(brief.block.startsOn).toBe(toIsoDate(BLOCK_START))
    expect(brief.block.totalWeeks).toBe(TOTAL_WEEKS)
    expect(brief.goal.timeS).toBe(GOAL_TIME_S)
    expect(brief.today).toEqual({ date: '2026-08-26', weekIndex: 1 })

    expect(brief.paceZones.map((band) => band.zone)).toEqual([...PACE_ZONES])
    for (const band of brief.paceZones) {
      expect(band.loSKm).toBe(PACES[band.zone].lo)
      expect(band.hiSKm).toBe(PACES[band.zone].hi)
    }
    expect(brief.sessionTypes.map((type) => type.type)).toEqual([...SESSION_TYPES])
  })

  it('answers without touching the database', async () => {
    const { isError, text } = await resultOf('get_block')
    expect(isError).toBe(false)
    expect(JSON.parse(text).block.totalWeeks).toBe(TOTAL_WEEKS)
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
      scheduledOn: toIsoDate(BLOCK_START),
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
        { id: 'w00-mon-0', scheduledOn: toIsoDate(BLOCK_START), type: 'easy', title: 'Rodaje' },
        { id: 'w00-tue-0', scheduledOn: 'nope', type: 'easy', title: 'Rodaje' },
        { id: 'w00-wed-0', scheduledOn: toIsoDate(BLOCK_START), type: 'flying', title: 'Rodaje' },
      ],
    })
    expect(isError).toBe(true)
    expect(text).toContain('nothing was written')

    const details = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { index: number }[]
    expect(details.map((failure) => failure.index)).toEqual([1, 2])
  })

  it('refuses a batch that would write the same id twice', async () => {
    const day = toIsoDate(BLOCK_START)
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
    const { isError, text } = await resultOf('upsert_week', { weekIndex: TOTAL_WEEKS, phase: 'Base' })
    expect(isError).toBe(true)
    expect(text).toContain('weekIndex')
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
  const limited = (): ToolRegistry => ({ ...stubRegistry(), withinLimit: async () => false })

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
    const { serverInfo, instructions, secret, list, call } = stubRegistry()
    const response = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      serverInfo,
      instructions,
      secret,
      list,
      call,
    })
    expect(response.status).toBe(200)
  })

  it('is checked after the origin, so a cross-origin caller cannot spend the budget', async () => {
    let consulted = false
    const registry: ToolRegistry = {
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
      registry,
    )
    expect(response.status).toBe(403)
    expect(consulted).toBe(false)
  })
})
