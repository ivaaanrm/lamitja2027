import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROUTES, TABS, documentTitle, normalizePath } from '@/lib/nav'

/**
 * The route table against the pages that actually exist.
 *
 * This is the same shape of test as `mcp.test.ts`: it reads source rather than calling a
 * function, because the bug it is looking for is invisible to every ordinary one. Every
 * screen in the app lives in a single React root now (`src/components/Shell.tsx`), and the
 * `.astro` files under `src/pages` exist only to prerender one document per route and hand
 * it the path it opened on. Those two halves have to agree, and nothing else checks that:
 *
 *   - A key of `ROUTES` with no page behind it is a deep link that 404s, and an internal
 *     link the router happily swallows into a URL the server cannot serve on reload.
 *   - A page passing a path that is *not* a key hydrates as `/` — the fallback in
 *     `router.ts`'s `make` — so `/progreso` would quietly open on Hoy.
 *
 * Both type-check cleanly, because `path` is a `string` on both sides. It has to be: the
 * table is data and the pages are markup.
 */
const PAGES_DIR = new URL('../../src/pages/', import.meta.url)

/** Every `<App path="…" />` in the pages directory, by file. */
function shellPages(): Map<string, string> {
  const found = new Map<string, string>()
  for (const name of readdirSync(PAGES_DIR)) {
    if (!name.endsWith('.astro')) continue
    const source = readFileSync(new URL(name, PAGES_DIR), 'utf8')
    const match = /<App\s+path="([^"]+)"/.exec(source)
    if (match) found.set(name, match[1])
  }
  return found
}

describe('nav · the route table and the pages behind it', () => {
  it('gives every route exactly one prerendered document', () => {
    const byPath = new Map([...shellPages()].map(([file, path]) => [path, file]))

    expect([...byPath.keys()].sort()).toEqual(Object.keys(ROUTES).sort())
  })

  it('never lets a page name a path the table does not know', () => {
    // The silent one: `make()` falls back to `/` for an unknown path, so a typo here is a
    // document that opens on Hoy no matter which URL was asked for.
    for (const [file, path] of shellPages()) {
      expect(ROUTES, `${file} points at ${path}`).toHaveProperty(path)
    }
  })

  it('keeps every page a one-liner over the shell', () => {
    // The four tabs were four hand-written shells once, and the drift between them —
    // different padding, a heading on one and not another — is what moved the column into
    // `Shell.tsx`. A page that grows markup of its own is that drift starting again.
    for (const [file] of shellPages()) {
      const source = readFileSync(new URL(file, PAGES_DIR), 'utf8')
      const body = source.split('---')[2] ?? ''
      expect(body.trim(), `${file} should render nothing but <App />`).toMatch(
        /^<App path="[^"]+" \/>$/,
      )
    }
  })

  it('lights a real dock entry for every tab', () => {
    for (const entry of TABS) {
      const meta = ROUTES[entry.href]
      expect(meta, `${entry.href} is in the dock`).toBeDefined()
      expect(meta.tab).toBe(entry.key)
    }
  })

  it('points every screen at a dock entry, or deliberately at none', () => {
    const keys = new Set<string>(TABS.map((entry) => entry.key))
    for (const [path, meta] of Object.entries(ROUTES)) {
      if (meta.tab === null) continue
      expect(keys, `${path} lights ${meta.tab}`).toContain(meta.tab)
    }
  })

  it('only lets one screen hide the dock, and gives it a way back instead', () => {
    // A screen with no bar and no chevron is a screen with no way out but the hardware
    // button, which a home-screen PWA does not have.
    for (const [path, meta] of Object.entries(ROUTES)) {
      if (meta.tab === null) expect(meta.back, `${path} has no dock`).toBeDefined()
    }
  })
})

describe('nav · paths and titles', () => {
  it('reads a trailing slash as the same route', () => {
    // Workers Assets is set to `drop-trailing-slash`, so `/plan` is canonical — but the
    // address bar, a shared link and the back button can all still say `/plan/`, and two
    // keys for one route is a dock with nothing lit.
    expect(normalizePath('/plan/')).toBe('/plan')
    expect(normalizePath('/plan')).toBe('/plan')
    expect(normalizePath('/')).toBe('/')
  })

  it('names the app alone on the tab it opens on', () => {
    expect(documentTitle('/')).not.toContain('·')
    expect(documentTitle('/plan')).toMatch(/^Plan · /)
    // An unknown path is the service worker's offline fallback serving `/`'s document for
    // a route this device never cached. It is not an error, and it is not a blank title.
    expect(documentTitle('/nada')).toBe(documentTitle('/'))
  })
})
