import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { json, readJson } from '@/lib/api'
import { clearSessionCookie, createSessionCookie } from '@/lib/auth'
import { loginInput } from '@/lib/auth-input'
import { createDb } from '@/lib/db/client'
import { DUMMY_HASH, DUMMY_SALT, verifyPassword } from '@/lib/password'
import { withinLimit } from '@/lib/ratelimit'
import { findByEmail } from '@/lib/users'

export const prerender = false

/** The one sentence this endpoint says when it says no — see the comment in POST. */
const WRONG = 'Correo o contraseña incorrectos'

/**
 * Email and password in, a signed cookie out. `APP_PASSWORD` no longer signs anyone in:
 * it is the one-time bootstrap secret now, and a shared password could not tell two
 * athletes apart in an app where every row belongs to one of them.
 */
export const POST: APIRoute = async ({ request }) => {
  // Before the body is read, let alone the password checked: a limiter a correct guess can
  // skip throttles nothing but the status code. See `src/lib/ratelimit.ts`. A person signs
  // in once per device per year, so the ceiling is only ever met by a script.
  if (!(await withinLimit('LOGIN_RATE_LIMIT', request))) {
    return json({ error: 'Demasiados intentos. Espera un minuto.' }, 429)
  }

  const parsed = loginInput.safeParse(await readJson(request))
  // A malformed body gets the same answer as a wrong password rather than `invalid()`'s
  // field-level detail: this endpoint has exactly two outcomes, and the form already
  // refuses an empty field, so anything reaching here with an unparseable address is a
  // script rather than a person who mistyped.
  if (!parsed.success) return json({ error: WRONG }, 401)

  const { email, password } = parsed.data
  const user = await findByEmail(createDb(env.DB), email)

  // The derivation runs whether or not the address exists, against a fixed throwaway hash
  // when it does not. Without it, "no such account" returns in a millisecond and "wrong
  // password" takes the ~100 ms of 210k PBKDF2 rounds, and the gap is a reliable oracle
  // for *which addresses have accounts here* — on a deployment whose whole membership is
  // a handful of named friends.
  //
  // What makes this affordable is the limiter above: 210k rounds on an unauthenticated
  // request is a denial-of-service lever right up until the point where a caller only
  // gets eight of them a minute.
  const ok = user
    ? await verifyPassword(password, user.passwordHash, user.passwordSalt)
    : await verifyPassword(password, DUMMY_HASH, DUMMY_SALT)

  if (!user || !ok) {
    // Deliberately vague, and the same for both branches: which half was wrong is the one
    // thing a stranger would learn something from.
    return json({ error: WRONG }, 401)
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await createSessionCookie(user.id) },
  })
}

export const DELETE: APIRoute = () =>
  new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie() } })
