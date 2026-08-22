import type { APIRoute } from 'astro'
import { destroySession } from '@/lib/auth/session'

export const prerender = false

export const POST: APIRoute = async (context) => {
  await destroySession(context)
  return new Response(null, { status: 302, headers: { location: '/' } })
}
