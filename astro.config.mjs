// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

// Static by default: every page is a prerendered app-shell so the PWA works
// offline. Only files under src/pages/api/ opt out via `export const prerender = false`.
export default defineConfig({
  adapter: cloudflare({
    // Astro Sessions are backed by the SESSION KV namespace (see wrangler.jsonc).
    sessionKVBindingName: 'SESSION',
    imageService: 'compile',
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
})
