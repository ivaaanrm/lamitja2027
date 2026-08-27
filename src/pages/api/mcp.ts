import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { createDb } from '@/lib/db/client'
import { handleMcp } from '@/lib/mcp/protocol'
import { resolveMcpToken } from '@/lib/mcp/resolve'
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from '@/lib/mcp/tools'
import { withinLimit } from '@/lib/ratelimit'

export const prerender = false

/**
 * The MCP endpoint: one address, and the only file in the server that knows where the
 * database comes from.
 *
 * `ALL` rather than `POST` on purpose. The transport owes a `GET` and a `DELETE` a
 * `405 Method Not Allowed` — that is how a client built against an older revision, which
 * still opens the server-initiated stream and still deletes its session on the way out,
 * is told this server has neither. Exporting only `POST` would hand those two Astro's own
 * 404 instead, which reads as "wrong URL" and sends someone looking for a typo.
 *
 * One address for every athlete, and the bearer token is what says which. `resolveMcpToken`
 * is the only way to obtain a registry, and it cannot produce one that is not somebody's —
 * see the comment there. Everything else — origin, version negotiation, dispatch — is
 * `protocol.ts`, and what the tools actually do is `tools.ts`. This file is the wiring.
 */
export const ALL: APIRoute = ({ request }) =>
  handleMcp(request, {
    serverInfo: { name: 'strideai-training', version: SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
    resolve: (token) => resolveMcpToken(createDb(env.DB), token),
    withinLimit: (candidate) => withinLimit('MCP_RATE_LIMIT', candidate),
  })
