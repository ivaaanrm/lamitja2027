import { eq } from 'drizzle-orm'
import { sha256Hex } from '../crypto'
import type { Database } from '../db/client'
import { blocks, users } from '../db/schema'
import { DEFAULT_HR_MAX, paceBands } from '../paces'
import { goalPaceSKm, type BlockConfig } from '../block'
import { d1GrantStore } from '../oauth/grants'
import { resolveAccessToken } from '../oauth/server'
import { createToolRegistry, type McpCtx } from './tools'
import type { ToolRegistry } from './protocol'

/**
 * Turning a bearer token into one athlete's tools — the only door into the MCP server.
 *
 * Two kinds of token open it, and both are **looked up by hash**, never compared against a
 * list:
 *
 *  - **An OAuth access token**, which is what Claude holds after the athlete added the app
 *    as a custom connector and pressed «Permitir» on `/autorizar`. It lives an hour, is
 *    refreshed by the client on its own, and is only accepted if it was issued *for this
 *    endpoint* (`resolveAccessToken`, RFC 8707) — see `src/lib/oauth/`.
 *  - **A static MCP token**, minted by hand on `/ajustes`, for a client that cannot run an
 *    OAuth flow and takes a header instead. It never expires; it is rotated or revoked.
 *
 * What makes the multi-athlete version of this endpoint safe is the same for both:
 *
 *  - each hash column is unique, so a token identifies exactly one athlete or none;
 *  - the lookup is an index probe on a SHA-256, so there is no byte-by-byte comparison to
 *    time and no token stored anywhere it could leak from;
 *  - what comes back is a registry with that athlete's id already closed over, so a tool
 *    cannot be called without an owner. There is no "unscoped" registry to obtain.
 *
 * An athlete who has minted no static token has `mcp_token_hash` null, and the null check
 * is what stops a caller presenting the empty string — whose hash is a real, constant
 * value — from matching a row that never opted in. (`protocol.ts` also refuses an empty
 * bearer before it gets here; both, because either one alone is a single point of failure.)
 *
 * A token belonging to an athlete who has not finished `/bienvenida` resolves to null too:
 * every tool counts weeks from a block, and there is no honest answer without one. The
 * consent screen refuses to connect such an athlete in the first place, for that reason.
 */
export async function resolveMcpToken(
  db: Database,
  token: string,
  resource: string,
  now = Date.now(),
): Promise<ToolRegistry | null> {
  if (!token) return null

  const tokenHash = await sha256Hex(token)
  const holder = await db.query.users.findFirst({ where: eq(users.mcpTokenHash, tokenHash) })
  const userId =
    holder?.mcpTokenHash ? holder.id : await resolveAccessToken(d1GrantStore(db), token, resource, now)
  if (!userId) return null

  const user = holder?.id === userId ? holder : await db.query.users.findFirst({ where: eq(users.id, userId) })
  if (!user) return null

  const row = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!row) return null

  const block: BlockConfig = {
    startsOn: row.startsOn,
    raceOn: row.raceOn,
    goalTimeS: row.goalTimeS,
    raceDistanceM: row.raceDistanceM,
    raceName: row.raceName,
    racePlace: row.racePlace,
  }
  const hrMax = user.hrMax ?? DEFAULT_HR_MAX

  const ctx: McpCtx = {
    db,
    userId: user.id,
    block,
    hrMax,
    bands: paceBands(goalPaceSKm(block)),
  }
  return createToolRegistry(ctx)
}
