import { env } from 'cloudflare:workers'
import { defineMiddleware } from 'astro:middleware'
import { sessionUserId } from './lib/auth'
import { createDb } from './lib/db/client'
import { findById, toSessionUser } from './lib/users'

/**
 * Gates the API and resolves who is asking. Every row behind `/api` belongs to one
 * athlete, so the default is closed and the exceptions are listed here rather than
 * remembered route by route.
 *
 * Page routes are prerendered and hold no data — the islands redirect to `/login` on
 * their first 401.
 */
const PUBLIC_PATHS = new Set([
  '/api/login',
  '/api/register',
  // The one-shot that gives the owner row its first password. It checks APP_PASSWORD itself.
  '/api/bootstrap',
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
 * so it presents `Authorization: Bearer <token>` — an athlete's own MCP token, minted on
 * `/ajustes` — and `src/lib/mcp/protocol.ts` resolves it to a user and compares it in
 * constant time before it will parse so much as the JSON-RPC method. It is a separate set
 * from `PUBLIC_PATHS` rather than another line in it because the difference is invisible
 * at a glance and the cost of getting it wrong is every athlete's training log: a path
 * dropped into the public list is a path with *no* check on it at all, and the only thing
 * standing between these two lists is that somebody remembered which one they were editing.
 */
const SELF_AUTHENTICATED_PATHS = new Set(['/api/mcp'])

/** Minting invitations is the only thing an ordinary athlete may not do. */
const ADMIN_PATHS = new Set(['/api/invites'])

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url
  // First, and before anything touches a binding: this also runs during the prerender
  // pass, where there is no request and no D1.
  if (!pathname.startsWith('/api/')) return next()
  if (PUBLIC_PATHS.has(pathname) || SELF_AUTHENTICATED_PATHS.has(pathname)) return next()

  const userId = await sessionUserId(context.request)
  // One read per request resolves the id to the athlete every route then scopes to. A
  // cookie whose row is gone counts as signed out: with no session table, deleting a user
  // is how their devices are revoked.
  const user = userId ? await findById(createDb(env.DB), userId) : null
  if (!user) {
    return new Response(JSON.stringify({ error: 'Sin iniciar sesión' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  context.locals.user = toSessionUser(user)

  if (ADMIN_PATHS.has(pathname) && !user.isAdmin) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }
  return next()
})
