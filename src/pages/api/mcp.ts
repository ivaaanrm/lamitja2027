import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { APP_NAME } from '@/lib/config'
import { sha256Hex } from '@/lib/crypto'
import { createDb } from '@/lib/db/client'
import { bearerToken, handleMcp } from '@/lib/mcp/protocol'
import { resolveMcpToken } from '@/lib/mcp/resolve'
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from '@/lib/mcp/tools'
import { bearerChallenge, resourceFor } from '@/lib/oauth/metadata'
import { withinLimit } from '@/lib/ratelimit'

export const prerender = false

/**
 * Claude's own origins. Its connector calls from Anthropic's servers and sends no `Origin`
 * today; these are let through so that the day it does, the DNS-rebinding check in
 * `protocol.ts` is not what disconnects every athlete at once.
 */
const CONNECTOR_ORIGINS = ['https://claude.ai', 'https://claude.com'] as const

/**
 * Who the limiter counts: the token presented, not the address it came from.
 *
 * Claude's connector calls from Anthropic's servers, so by IP every athlete using Claude
 * would be one caller, and one agent writing a block in a burst would throttle all the
 * others. Keying on the token is safe here where it would not be at `/api/login`: these
 * tokens are 256 random bits, so a guesser rotating through fresh values gains a fresh
 * bucket and still nothing to guess with. A request with no token at all falls back to its
 * IP. The fingerprint is a hash prefix, so the limiter never holds a usable credential.
 *
 * What a fresh bucket per made-up token *does* buy is volume — two index probes a request,
 * unthrottled — so a per-IP ceiling (`MCP_IP_RATE_LIMIT`, ten times higher) is asked first.
 */
async function limiterKey(request: Request): Promise<string | undefined> {
  const token = bearerToken(request)
  return token ? `token:${(await sha256Hex(token)).slice(0, 32)}` : undefined
}

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
 * see the comment there. The origin is read off the request because the same Worker answers
 * on more than one host, and a token is bound to the one it was issued on: this endpoint's
 * own URL is the `resource` an OAuth token has to name, and its discovery document is what
 * a `401` points at. Everything else — origin, version negotiation, dispatch — is
 * `protocol.ts`, and what the tools actually do is `tools.ts`. This file is the wiring.
 */
export const ALL: APIRoute = ({ request }) => {
  const origin = new URL(request.url).origin
  return handleMcp(request, {
    serverInfo: {
      name: 'treximo-training',
      title: APP_NAME,
      version: SERVER_VERSION,
      websiteUrl: origin,
      icons: [
        { src: `${origin}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
        { src: `${origin}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      ],
    },
    instructions: SERVER_INSTRUCTIONS,
    resolve: (token) => resolveMcpToken(createDb(env.DB), token, resourceFor(origin)),
    // Pointing a `…/api/mcp/` request at the document that names it with the slash, which
    // is the only one Claude will accept for that address.
    challenge: (error) => bearerChallenge(origin, error, new URL(request.url).pathname.endsWith('/')),
    allowedOrigins: CONNECTOR_ORIGINS,
    withinLimit: async (candidate) =>
      (await withinLimit('MCP_IP_RATE_LIMIT', candidate)) &&
      (await withinLimit('MCP_RATE_LIMIT', candidate, await limiterKey(candidate))),
  })
}
