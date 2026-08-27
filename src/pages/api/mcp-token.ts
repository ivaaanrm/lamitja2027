import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { json } from '@/lib/api'
import { randomToken, sha256Hex } from '@/lib/crypto'
import { createDb } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

export const prerender = false

/**
 * The athlete's MCP credential: minted here, shown once, stored only as a hash.
 *
 * It is a token of its own rather than the login password, and that is the whole point.
 * An MCP token is pasted into an agent's config file, where it sits in plain text and gets
 * copied around; a password is typed. Making them the same string would mean handing an
 * agent the ability to sign in as the athlete, and would mean rotating the password to
 * revoke an agent. These rotate independently, and revoking one costs nothing.
 *
 * `POST` mints and *replaces* — there is one token per athlete, so calling it again is how
 * you rotate, and the previous token stops working the moment this returns. The plaintext
 * is in the response body and nowhere else: `users.mcp_token_hash` holds `sha256(token)`,
 * so a database dump hands over fingerprints. Losing it means minting another.
 *
 * `DELETE` revokes without replacing, which is what an athlete wants when an agent is
 * decommissioned rather than moved.
 */
export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user!
  // 32 bytes, URL-safe: it travels in an `Authorization` header and through a config file,
  // so it may not need quoting or escaping anywhere on the way.
  const token = randomToken(32)

  await createDb(env.DB)
    .update(users)
    .set({ mcpTokenHash: await sha256Hex(token) })
    .where(eq(users.id, user.id))

  return json({ token }, 201)
}

export const DELETE: APIRoute = async ({ locals }) => {
  await createDb(env.DB)
    .update(users)
    .set({ mcpTokenHash: null })
    .where(eq(users.id, locals.user!.id))

  return new Response(null, { status: 204 })
}
