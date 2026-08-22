import type { APIRoute } from 'astro'
import { checkPassword, clearSessionCookie, createSessionCookie, json } from '@/lib/auth'

export const prerender = false

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData().catch(() => null)
  const password = String(form?.get('password') ?? '')

  if (!checkPassword(password)) {
    // Deliberately vague, and no timing signal — checkPassword is constant-time.
    return json({ error: 'Wrong password' }, 401)
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await createSessionCookie() },
  })
}

export const DELETE: APIRoute = () =>
  new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie() } })
