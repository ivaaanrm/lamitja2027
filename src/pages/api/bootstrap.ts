import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { invalid, json, readJson } from '@/lib/api'
import { checkBootstrapSecret, createSessionCookie } from '@/lib/auth'
import { bootstrapInput } from '@/lib/auth-input'
import { createDb } from '@/lib/db/client'
import { bootstrapOwner } from '@/lib/users'

export const prerender = false

/**
 * The migration path for the athlete who was here before there were accounts, and nothing
 * beyond it. `migrations/0004` hands the existing block, plan and activities to a row with
 * an empty `password_hash`; this is the one call that gives that row a password, an email
 * and a session — after which it 409s forever, because `bootstrapOwner` looks for an empty
 * hash and no password derives to one.
 *
 * It is public because there is nobody to authenticate against yet: `APP_PASSWORD`, which
 * used to be the login, is now the secret that authorises exactly this. There is no rate
 * limit on it, and it does not need one for long — the window closes on first success, and
 * `timingSafeEqual` keeps the comparison from leaking the secret a character at a time.
 * Once the owner is bootstrapped, every later athlete arrives through `/api/register`.
 */
export const POST: APIRoute = async ({ request }) => {
  const parsed = bootstrapInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const { password, email, newPassword, displayName } = parsed.data
  if (!checkBootstrapSecret(password)) return json({ error: 'Secreto incorrecto' }, 401)

  // Null means the owner row already has a hash — the app is configured, and this endpoint
  // is done. Checked by the UPDATE's WHERE rather than by a read before it, so a second
  // call cannot overwrite a password by racing the check.
  const owner = await bootstrapOwner(createDb(env.DB), {
    email,
    password: newPassword,
    displayName,
  })
  if (!owner) return json({ error: 'La aplicación ya está configurada' }, 409)

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await createSessionCookie(owner.id) },
  })
}
