/// <reference types="../worker-configuration.d.ts" />
import { handle } from '@astrojs/cloudflare/handler'
import { runScheduled } from './lib/sync/scheduled'

/**
 * One Worker serves both roles:
 *  - `fetch`     → the Astro app (prerendered shell + /api routes)
 *  - `scheduled` → Cron Triggers (see `triggers.crons` in wrangler.jsonc)
 *
 * The Cloudflare adapter honours the `main` field in wrangler.jsonc, so this
 * file replaces the adapter's own entrypoint while still delegating to it.
 */
export default {
  fetch: handle,

  async scheduled(controller, env, ctx) {
    await runScheduled(controller, env, ctx)
  },
} satisfies ExportedHandler<Env>
