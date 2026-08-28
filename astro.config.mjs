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
   * No prefetching, because there is nothing left to prefetch.
   *
   * This used to be `{ prefetchAll: true, defaultStrategy: 'tap' }`, with the four dock
   * links opting up to `viewport` by hand — the shells for the four tabs in hand before a
   * thumb moved. Every screen behind the dock is one document now
   * (`src/components/Shell.tsx`), so a tab tap fetches nothing at all and warming those
   * shells would download six copies of markup this session will never ask for. The links
   * that do still cross a document — `/login`, `/alta`, `/bienvenida` — are each crossed
   * once, at a moment with nothing else in flight.
   */
  prefetch: false,
  // Astro reads the dev port from here or `--port`, never from the environment, so a tool
  // that assigns a port (and the localhost OAuth callback cannot, see AGENTS.md §8, so
  // nothing here is pinned to 4321) has no way to hand one over without this.
  server: { port: Number(process.env.PORT) || 4321 },
  vite: {
    plugins: [tailwindcss()],
  },
})
