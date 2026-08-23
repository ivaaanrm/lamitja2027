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
  // The dock is always on screen, so "viewport" here means the four tab shells are fetched
  // as soon as any page opens — a tab switch then never waits on the network.
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  // Astro reads the dev port from here or `--port`, never from the environment, so a tool
  // that assigns a port (and the localhost OAuth callback cannot, see AGENTS.md §8, so
  // nothing here is pinned to 4321) has no way to hand one over without this.
  server: { port: Number(process.env.PORT) || 4321 },
  vite: {
    plugins: [tailwindcss()],
  },
})
