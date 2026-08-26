// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

// Static by default: every page is a prerendered app shell. Only files under
// src/pages/api/ opt out via `export const prerender = false`.
export default defineConfig({
  // Only used to build absolute URLs at prerender time (the Open Graph image).
  site: 'https://lamitja2027.iromero-py.workers.dev',
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [react()],
  /**
   * Every link prefetches, but only the dock does it eagerly.
   *
   * `viewport` was the default here, and on the dock it is exactly right — four links that
   * are always on screen, so the four tab shells are in hand before a thumb moves. Applied
   * to *every* link it was a bandwidth leak, because Astro dedupes prefetches by full URL
   * and this app's two detail screens are one prerendered shell addressed by a query
   * string: scrolling `/registro` past a hundred and fifty rows queued a hundred and fifty
   * prefetches of the same `/actividad` document, and opening weeks in `/plan` did it
   * again for `/sesion`. On a phone on cellular that is megabytes spent re-fetching one
   * file.
   *
   * `tap` is the honest default for a touch device: it fires on `touchstart`, which buys
   * the ~100ms between the finger landing and the tap completing, for exactly the one URL
   * being opened. (`hover` would prefetch nothing at all on a phone — there is no
   * mouseenter.) The four dock links opt back into `viewport` by hand, in `Dock.astro`.
   */
  prefetch: { prefetchAll: true, defaultStrategy: 'tap' },
  // Astro reads the dev port from here or `--port`, never from the environment, so a tool
  // that assigns a port (and the localhost OAuth callback cannot, see AGENTS.md §8, so
  // nothing here is pinned to 4321) has no way to hand one over without this.
  server: { port: Number(process.env.PORT) || 4321 },
  vite: {
    plugins: [tailwindcss()],
  },
})
