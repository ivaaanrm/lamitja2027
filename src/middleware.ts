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

/**
 * **Not public.** These paths carry their own authentication *inside the route*, so the
 * session cookie is the wrong test for them and this middleware would only ever return a
 * 401 the caller could not act on.
 *
 * `/api/mcp` is the MCP server. An agent has no cookie jar and no login form to post to,
 * so it presents `Authorization: Bearer <APP_PASSWORD>` — the same single password the
 * cookie is minted from — and `src/lib/mcp/protocol.ts` compares it in constant time
 * before it will parse so much as the JSON-RPC method. It is a separate set from
 * `PUBLIC_PATHS` rather than another line in it because the difference is invisible at a
 * glance and the cost of getting it wrong is the whole training log: a path dropped into
 * the public list is a path with *no* check on it at all, and the only thing standing
 * between these two lists is that somebody remembered which one they were editing.
 */
const SELF_AUTHENTICATED_PATHS = new Set(['/api/mcp'])

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url
  if (!pathname.startsWith('/api/')) return next()
  if (PUBLIC_PATHS.has(pathname) || SELF_AUTHENTICATED_PATHS.has(pathname)) return next()

  if (!(await isSignedIn(context.request))) {
    return new Response(JSON.stringify({ error: 'Sin iniciar sesión' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  return next()
})
