import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { inviteInput } from '@/lib/auth-input'
import { createDb } from '@/lib/db/client'
import { createInvite, inviteUrl, listInvites } from '@/lib/invites'

export const prerender = false

/**
 * Minting and listing invitations — the whole membership model, and the only thing an
 * ordinary athlete may not do. The 403 lives in `src/middleware.ts` (`ADMIN_PATHS`), so
 * both handlers here can assume an admin: the middleware answers before the route runs,
 * which is also why neither of them re-reads the cookie.
 */

/**
 * What has been handed out and what became of it. No token and no hash: the hash is all
 * the database has, and a spent fingerprint is not something a screen ever needs to show.
 * `usedBy` is the id the claim wrote — enough for the admin card to mark a link as taken.
 */
export const GET: APIRoute = async () => {
  const rows = await listInvites(createDb(env.DB))
  return json({
    invites: rows.map(({ note, expiresAt, usedAt, usedBy }) => ({
      note,
      expiresAt,
      usedAt,
      usedBy,
    })),
  })
}

/**
 * Mints one single-use link.
 *
 * The raw token is in this response and in no other, ever: only `sha256Hex(token)` is
 * stored, so there is nothing to read it back out of — a database dump hands over
 * fingerprints rather than working invitations. The caller has one chance to copy it, and
 * losing it means minting another one rather than looking the old one up.
 *
 * The origin comes from the request rather than a configured base URL, so a link minted
 * from the deployed host points at the deployed host and one minted from a preview points
 * at the preview.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  // No body at all is a link with no note — the common case from the `/ajustes` card,
  // which posts nothing but the button press.
  const parsed = inviteInput.safeParse((await readJson(request)) ?? {})
  if (!parsed.success) return invalid(parsed.error)

  // Present because the middleware gated this path; it 401s before an unauthenticated
  // request can reach a route, and 403s a non-admin one.
  const admin = locals.user!
  const { token, expiresAt } = await createInvite(
    createDb(env.DB),
    admin.id,
    parsed.data.note,
    Date.now(),
  )

  return json({ url: inviteUrl(url.origin, token), expiresAt }, 201)
}
