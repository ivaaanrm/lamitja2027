import { defineMiddleware } from 'astro:middleware'
import { isSignedIn } from './lib/auth'

/**
 * Gates the API. Everything is one athlete's private training data, so the default is
 * closed and exceptions are listed explicitly.
 */
const PUBLIC_PATHS = new Set([
  '/api/login',
  // Strava calls these itself and authenticates by its own verify token / OAuth state.
  '/api/strava/webhook',
  '/api/strava/callback',
])

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url
  if (!pathname.startsWith('/api/') || PUBLIC_PATHS.has(pathname)) return next()

  if (!(await isSignedIn(context.request))) {
    return new Response(JSON.stringify({ error: 'Sin iniciar sesión' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  return next()
})
