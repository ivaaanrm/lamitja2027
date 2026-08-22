// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

// Static by default: every page is a prerendered app shell. Only files under
// src/pages/api/ opt out via `export const prerender = false`.
export default defineConfig({
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
})
