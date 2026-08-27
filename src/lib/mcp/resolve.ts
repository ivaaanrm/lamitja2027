import { eq } from 'drizzle-orm'
import { sha256Hex } from '../crypto'
import type { Database } from '../db/client'
import { blocks, users } from '../db/schema'
import { DEFAULT_HR_MAX, paceBands } from '../paces'
import { goalPaceSKm, type BlockConfig } from '../block'
import { createToolRegistry, type McpCtx } from './tools'
import type { ToolRegistry } from './protocol'

/**
 * Turning a bearer token into one athlete's tools — the only door into the MCP server.
 *
 * The token is **looked up by hash**, never compared against a list. That is worth being
 * explicit about, because it is what makes the multi-athlete version of this endpoint safe
 * in a way a shared secret never was:
 *
 *  - `users.mcp_token_hash` is unique, so a token identifies exactly one athlete or none;
 *  - the lookup is an index probe on a SHA-256, so there is no byte-by-byte comparison to
 *    time and no token stored anywhere it could leak from;
 *  - what comes back is a registry with that athlete's id already closed over, so a tool
 *    cannot be called without an owner. There is no "unscoped" registry to obtain.
 *
 * An athlete who has minted no token has `mcp_token_hash` null, and the `isNotNull` guard
 * is what stops a caller presenting the empty string — whose hash is a real, constant
 * value — from matching a row that never opted in. (`protocol.ts` also refuses an empty
 * bearer before it gets here; both, because either one alone is a single point of failure.)
 *
 * A token belonging to an athlete who has not finished `/bienvenida` resolves to null too:
 * every tool counts weeks from a block, and there is no honest answer without one.
 */
export async function resolveMcpToken(db: Database, token: string): Promise<ToolRegistry | null> {
  if (!token) return null

  const tokenHash = await sha256Hex(token)
  const user = await db.query.users.findFirst({ where: eq(users.mcpTokenHash, tokenHash) })
  if (!user || !user.mcpTokenHash) return null

  const row = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!row) return null

  const block: BlockConfig = {
    startsOn: row.startsOn,
    raceOn: row.raceOn,
    goalTimeS: row.goalTimeS,
    raceDistanceM: row.raceDistanceM,
    raceName: row.raceName,
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
