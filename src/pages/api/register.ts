import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { createSessionCookie } from '@/lib/auth'
import { registerInput } from '@/lib/auth-input'
import { createDb } from '@/lib/db/client'
import { claimInvite, isClaimable } from '@/lib/invites'
import { createUser, deleteUser, findByEmail } from '@/lib/users'

export const prerender = false

/** One message for every way an invitation can fail — expired, spent, or never minted. */
const BAD_INVITE = 'Invitación no válida o ya usada'

/**
 * The only way an account comes into existence, `/api/bootstrap`'s one-shot aside: someone
 * opened a link an admin minted. There is no open sign-up, no email verification and no
 * reset — losing the password means being re-invited.
 *
 * The order is load-bearing and cannot be tidied. `invites.usedBy` is a foreign key onto
 * `users.id` and D1 enforces it, so the account has to exist before its invite can be
 * claimed; and D1 has no interactive transaction to wrap the pair in. So: look (cheap,
 * non-binding), create, then claim — and if the claim loses a race with another tab on
 * the same link, undo the account. An account undone is recoverable by minting another
 * link; an account left standing on a spent invitation is a hole in the membership model.
 */
export const POST: APIRoute = async ({ request }) => {
  const parsed = registerInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const { token, email, password, displayName } = parsed.data
  const db = createDb(env.DB)
  const now = Date.now()

  // Non-binding, and only here so the common failure — a link that is plainly expired or
  // already spent — costs no account and no PBKDF2. `claimInvite` below is the authority.
  if (!(await isClaimable(db, token, now))) return json({ error: BAD_INVITE }, 400)

  // The unique index on `email` is what actually decides this; the read only buys a
  // sentence worth rendering. Two people registering the same address in the same second
  // is a 500 for the loser, which is both correct and vanishingly unlikely here.
  if (await findByEmail(db, email)) return json({ error: 'Ya hay una cuenta con ese correo' }, 409)

  const user = await createUser(db, { email, password, displayName })
  if (!(await claimInvite(db, token, user.id, now))) {
    await deleteUser(db, user.id)
    return json({ error: BAD_INVITE }, 400)
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await createSessionCookie(user.id) },
  })
}
