/// <reference types="../worker-configuration.d.ts" />
import { handle } from '@astrojs/cloudflare/handler'
import { createDb } from './lib/db/client'
import { d1GrantStore } from './lib/oauth/grants'
import { handleOAuth, isOAuthPath } from './lib/oauth/server'
import { withinLimit } from './lib/ratelimit'
import { runScheduled } from './lib/scheduled'

/**
 * One Worker serves both roles:
 *  - `fetch`     → the OAuth authorization server's own paths, then the Astro app
 *                  (prerendered shell + /api routes) for everything else
 *  - `scheduled` → the nightly Strava sync
 *
 * The Cloudflare adapter honours `main` in wrangler.jsonc, which is what lets this file
 * replace the adapter's own entrypoint while still delegating to it.
 *
 * The OAuth paths (`/oauth/*` and two `/.well-known/` documents) are answered here, before
 * Astro is involved, and that is not a shortcut. Astro's CSRF check refuses any
 * form-encoded POST whose `Origin` is not this site, and an OAuth token request is a
 * form-encoded POST from the client's *server*, carrying no `Origin` at all — so behind
 * Astro, every code exchange Claude made would be a `403`. Turning the check off
 * app-wide to let one endpoint through would trade the protection every other route has
 * for it. `isOAuthPath` is a string comparison, so every other request pays nothing.
 */
export default {
  async fetch(request, env, ctx) {
    if (isOAuthPath(new URL(request.url).pathname)) {
      try {
        const response = await handleOAuth(request, {
          secret: env.SESSION_SECRET,
          store: d1GrantStore(createDb(env.DB)),
          // Wrapped: the runtime's `fetch` throws "Illegal invocation" when called detached.
          fetch: (input, init) => fetch(input, init),
          withinLimit: (candidate) => withinLimit('OAUTH_RATE_LIMIT', candidate),
        })
        if (response) return response
      } catch (error) {
        // An OAuth client reads `error`, never a stack, and a bare 500 from the runtime is
        // an HTML page it cannot parse. The detail goes to the Worker's log instead.
        console.error('[oauth]', error)
        return new Response(JSON.stringify({ error: 'server_error' }), {
          status: 500,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      }
    }
    return handle(request, env, ctx)
  },
  scheduled: (controller) => runScheduled(controller),
} satisfies ExportedHandler<Env>
