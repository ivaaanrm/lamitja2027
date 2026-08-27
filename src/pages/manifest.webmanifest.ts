import type { APIRoute } from 'astro'
import { TOTAL_WEEKS } from '@/lib/block'
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME } from '@/lib/config'

/**
 * The manifest, generated rather than served from `public/`.
 *
 * It was a static JSON file, which is the obvious thing for it to be and the reason the
 * app's name was stranded: `public/` is copied byte-for-byte, so nothing in there can read
 * a build-time value. A fork could rename every heading in the app and still install a
 * home-screen icon labelled *La Mitja* — on the one surface where the name is most visible
 * and hardest to notice is wrong, because you only see it after you install.
 *
 * Prerendered like every other page here, so this costs a file at build time and no
 * request at runtime. The extension is what sets the content type: Workers Assets serves
 * `.webmanifest` as `application/manifest+json`, so there is no header to hand-write.
 *
 * `background_color` and `theme_color` are `--color-surface` written out, because JSON
 * cannot read a token. They are copies, they drift silently, and they have drifted before
 * — see the palette convention in AGENTS.md, which lists all four places this happens.
 */
const SURFACE = '#12151a'

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      {
        id: '/',
        name: APP_NAME,
        short_name: APP_SHORT_NAME,
        description: APP_DESCRIPTION,
        lang: 'es-ES',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'portrait',
        background_color: SURFACE,
        theme_color: SURFACE,
        categories: ['health', 'fitness', 'sports'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // The three tabs worth a long-press. `/` is the app itself and needs no shortcut.
        shortcuts: [
          {
            name: 'Plan',
            short_name: 'Plan',
            description: `Las ${TOTAL_WEEKS} semanas del bloque`,
            url: '/plan',
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Progreso',
            short_name: 'Progreso',
            description: 'La temporada contra la anterior',
            url: '/progreso',
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Registro',
            short_name: 'Registro',
            description: 'Todo lo corrido dentro del bloque',
            url: '/registro',
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      null,
      2,
    ),
  )
