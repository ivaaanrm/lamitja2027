import type { APIRoute } from 'astro'
import { json } from '@/lib/api'
import { checkPassword, clearSessionCookie, createSessionCookie } from '@/lib/auth'
import { withinLimit } from '@/lib/ratelimit'

export const prerender = false

export const POST: APIRoute = async ({ request }) => {
  // Before the password is read, not after: a limiter a correct guess can skip throttles
  // nothing but the status code. See `src/lib/ratelimit.ts`. A person signs in once per
  // device per year, so the ceiling is only ever met by a script or by a bad morning.
  if (!(await withinLimit('LOGIN_RATE_LIMIT', request))) {
    return json({ error: 'Demasiados intentos. Espera un minuto.' }, 429)
  }

  const form = await request.formData().catch(() => null)
  const password = String(form?.get('password') ?? '')

  if (!checkPassword(password)) {
    // Deliberately vague, and no timing signal — checkPassword is constant-time.
    return json({ error: 'Contraseña incorrecta' }, 401)
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await createSessionCookie() },
  })
}

export const DELETE: APIRoute = () =>
  new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie() } })
