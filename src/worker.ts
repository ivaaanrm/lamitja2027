/// <reference types="../worker-configuration.d.ts" />
import { handle } from '@astrojs/cloudflare/handler'
import { runScheduled } from './lib/scheduled'

/**
 * One Worker serves both roles:
 *  - `fetch`     → the Astro app (prerendered shell + /api routes)
 *  - `scheduled` → the nightly Strava sync
 *
 * The Cloudflare adapter honours `main` in wrangler.jsonc, which is what lets this file
 * replace the adapter's own entrypoint while still delegating to it.
 */
export default {
  fetch: handle,
  scheduled: (controller) => runScheduled(controller),
} satisfies ExportedHandler<Env>
