import { beforeEach, describe, expect, it, vi } from 'vitest'
import source from '../../public/sw.js?raw'

/**
 * The offline layer, exercised without a browser.
 *
 * `public/sw.js` is the one file in the app that no page imports and no test would reach
 * on its own — it is loaded by the browser, in a worker, against three caches and a
 * network that has to be *taken away* for half of its behaviour to show at all. That is
 * exactly the shape of code that quietly stops working: nothing on screen changes when a
 * caching rule is wrong until the morning someone opens the app in a car park.
 *
 * So it is evaluated here in plain Node with three things replaced — `caches`, `fetch` and
 * `self` — and the event objects handed to it by hand. Everything else it touches
 * (`Request`, `Response`, `Headers`, `URL`) is a real Node global, so what runs is the
 * shipped source and not a paraphrase of it. `?raw` reaches outside `src/` the same way
 * `baseline.ts` reaches into `docs/personal/data` (AGENTS gotcha 14).
 */

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

const keyOf = (request: Request | string) =>
  typeof request === 'string' ? new URL(request, 'https://app.test').toString() : request.url

/**
 * The cache generation, read out of the shipped source rather than typed here.
 *
 * `VERSION` is *meant* to move — the file's own header says to bump it whenever the
 * precache list or a caching rule changes, which is the same commit that most often
 * touches these tests. Hardcoding `lm-core-v4` in eleven places made every one of those
 * bumps look like six regressions, which is the worst possible signal: a test that cries
 * wolf on the correct change trains you to re-baseline it without reading the failure.
 *
 * What these tests are actually about is the *split* — that shells, core, data and assets
 * go to four different caches and that only three of them are versioned. Naming the
 * generation is incidental to all of it.
 */
const VERSION = /^const VERSION = '([^']+)'$/m.exec(source)?.[1]
if (!VERSION) throw new Error('public/sw.js no longer declares `const VERSION = ...`')

const CORE = `lm-core-${VERSION}`
const PAGES = `lm-pages-${VERSION}`
const DATA = `lm-data-${VERSION}`

class MemoryCache {
  readonly store = new Map<string, Response>()

  /** The harness's `fetch`, not the global one — `cache.add()` goes through it. */
  constructor(private readonly net: typeof fetch) {}

  async match(request: Request | string): Promise<Response | undefined> {
    // Cloned on the way out, so one stored entry can be read more than once.
    return this.store.get(keyOf(request))?.clone()
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.store.set(keyOf(request), response)
  }

  async add(url: string): Promise<void> {
    const response = await this.net(url)
    if (!response.ok) throw new Error(`add() failed: ${url}`)
    await this.put(url, response)
  }

  async delete(request: Request | string): Promise<boolean> {
    return this.store.delete(keyOf(request))
  }

  /** Insertion order, which is what the worker's LRU trim relies on. */
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url))
  }
}

class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>()

  constructor(private readonly net: typeof fetch) {}

  async open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name)
    if (!cache) this.caches.set(name, (cache = new MemoryCache(this.net)))
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }
}

type Handler = (event: any) => void

interface Harness {
  caches: MemoryCacheStorage
  fetch: ReturnType<typeof vi.fn>
  install: () => Promise<void>
  activate: () => Promise<void>
  /** `null` when the worker declined to intercept — which is itself a behaviour to assert. */
  request: (input: string, init?: RequestInit) => Promise<Response | null>
  claimed: boolean
}

/** Loads the shipped worker into a fresh set of stubs. */
function load(): Harness {
  const listeners = new Map<string, Handler>()
  const fetchMock = vi.fn()
  const cacheStorage = new MemoryCacheStorage(((...args: Parameters<typeof fetch>) =>
    fetchMock(...args)) as typeof fetch)

  const self = {
    location: new URL('https://app.test/sw.js'),
    registration: { navigationPreload: { enable: async () => {} } },
    clients: { claim: async () => void (harness.claimed = true) },
    skipWaiting: async () => {},
    addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
  }

  const run = async (type: string, extra: Record<string, unknown> = {}) => {
    const pending: Promise<unknown>[] = []
    const event = { waitUntil: (p: Promise<unknown>) => pending.push(p), ...extra }
    listeners.get(type)?.(event)
    await Promise.all(pending)
  }

  const harness: Harness = {
    caches: cacheStorage,
    fetch: fetchMock,
    claimed: false,
    install: () => run('install'),
    activate: () => run('activate'),
    request: async (input, init) => {
      const request = new Request(new URL(input, 'https://app.test'), init)
      let answer: Promise<Response> | null = null
      const pending: Promise<unknown>[] = []
      const event = {
        request,
        preloadResponse: Promise.resolve(undefined),
        respondWith: (p: Promise<Response>) => (answer = p),
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      }
      listeners.get('fetch')?.(event)
      const response = answer === null ? null : await answer
      // The worker writes to its caches inside `waitUntil`, so a test that asserts on a
      // cache has to wait for the same promises the browser would.
      await Promise.all(pending)
      return response
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', source)(self, cacheStorage, fetchMock)
  return harness
}

const html = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const DOC = { headers: { accept: 'text/html' } }

// ---------------------------------------------------------------------------

describe('service worker · install and activate', () => {
  let sw: Harness

  beforeEach(() => {
    sw = load()
    sw.fetch.mockImplementation(async () => new Response('ok'))
  })

  it('precaches the files whose URLs carry no hash', async () => {
    await sw.install()

    const core = await sw.caches.open(CORE)
    expect([...core.store.keys()].sort()).toEqual([
      'https://app.test/favicon.svg',
      'https://app.test/fonts/inter-latin.woff2',
      'https://app.test/fonts/manrope-latin.woff2',
      'https://app.test/fonts/schibsted-grotesk-latin.woff2',
      'https://app.test/icon-192.png',
      'https://app.test/manifest.webmanifest',
    ])
  })

  it('installs even when one precached file is missing', async () => {
    // `addAll` would reject the whole install here, and an install that fails is a worker
    // that never activates — no offline support at all, from one renamed icon.
    sw.fetch.mockImplementation(async (input: Request | string) =>
      String(typeof input === 'string' ? input : input.url).includes('icon-192')
        ? new Response('nope', { status: 404 })
        : new Response('ok'),
    )

    await expect(sw.install()).resolves.toBeUndefined()
    const core = await sw.caches.open(CORE)
    // Everything on the list except the one that 404'd.
    expect(core.store.size).toBe(5)
  })

  it('drops its own old caches on activate and keeps everything else', async () => {
    await sw.caches.open('lm-pages-v0')
    await sw.caches.open('lm-assets')
    await sw.caches.open('some-other-app')

    await sw.activate()

    const names = await sw.caches.keys()
    expect(names).not.toContain('lm-pages-v0')
    // Unversioned on purpose: every filename in it carries a content hash, so an entry
    // can only ever be surplus — never stale — and purging it would throw away a good
    // copy of a file that is still current.
    expect(names).toContain('lm-assets')
    expect(names).toContain('some-other-app')
    expect(sw.claimed).toBe(true)
  })
})

describe('service worker · app shells', () => {
  let sw: Harness

  beforeEach(() => {
    sw = load()
  })

  it('goes to the network first for a navigation, so a launch is never a stale build', async () => {
    // The request that boots the app has to be the current build: a stale shell asks for
    // `/_astro/*` chunks the last deploy removed, and the app opens to nothing.
    sw.fetch.mockResolvedValueOnce(html('<p>v1</p>'))
    await sw.request('/registro', DOC)

    sw.fetch.mockResolvedValueOnce(html('<p>v2</p>'))
    const second = await sw.request('/registro', DOC)

    expect(await second!.text()).toBe('<p>v2</p>')
    expect(sw.fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves a request that is not a navigation alone', async () => {
    // The one behaviour this file lost on purpose. A shell used to be asked for by three
    // callers — a navigation, a `ClientRouter` tab swap and a `<link rel="prefetch">` —
    // and the last two carry no navigate mode, no document destination and no
    // `Accept: text/html`, so they had to be caught by "no file extension" and answered
    // cache-first. The tabs are one document now and prefetching is off, so nothing but
    // the browser asks: an extensionless GET with none of the three signals is not this
    // worker's business and falls straight through.
    const passed = await sw.request('/progreso')

    expect(passed).toBeNull()
    expect(sw.fetch).not.toHaveBeenCalled()
  })

  it('stores one entry per route, not one per query string', async () => {
    sw.fetch.mockResolvedValue(html('<p>actividad</p>'))
    await sw.request('/actividad?id=1', DOC)
    await sw.request('/actividad?id=2', DOC)

    // `/actividad` is a single prerendered document addressed by a query the server never
    // reads. Keyed per URL, a hundred and fifty runs in the log would be a hundred and
    // fifty copies of one file.
    const pages = await sw.caches.open(PAGES)
    expect([...pages.store.keys()]).toEqual(['https://app.test/actividad'])
  })

  it('answers from that one entry for any activity once the connection is gone', async () => {
    sw.fetch.mockResolvedValueOnce(html('<p>actividad</p>'))
    await sw.request('/actividad?id=1', DOC)

    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await sw.request('/actividad?id=99', DOC)

    expect(offline!.status).toBe(200)
    expect(await offline!.text()).toBe('<p>actividad</p>')
  })

  it('falls back to Hoy for a route this device never opened', async () => {
    sw.fetch.mockResolvedValueOnce(html('<p>hoy</p>'))
    await sw.request('/', DOC)

    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await sw.request('/progreso', DOC)

    // Every tab is one tap away on the dock, which is why `/` is the right stand-in.
    expect(await offline!.text()).toBe('<p>hoy</p>')
  })

  it('does not let a failed read replace the shell it already has', async () => {
    sw.fetch.mockResolvedValueOnce(html('<p>plan</p>'))
    await sw.request('/plan', DOC)

    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await sw.request('/plan', DOC)

    expect(await offline!.text()).toBe('<p>plan</p>')
    const pages = await sw.caches.open(PAGES)
    expect(await pages.store.get('https://app.test/plan')!.clone().text()).toBe('<p>plan</p>')
  })

  it('has a screen of its own when even Hoy has never been cached', async () => {
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await sw.request('/plan', DOC)

    expect(offline!.status).toBe(503)
    const body = await offline!.text()
    expect(body).toContain('Sin conexión')
    expect(body).toContain('lang="es"')
  })
})

describe('service worker · build assets', () => {
  let sw: Harness

  beforeEach(() => {
    sw = load()
  })

  it('serves a hashed file from the cache without asking the network twice', async () => {
    sw.fetch.mockResolvedValueOnce(new Response('console.log(1)'))
    await sw.request('/_astro/Dashboard.abc123.js')
    const again = await sw.request('/_astro/Dashboard.abc123.js')

    expect(sw.fetch).toHaveBeenCalledTimes(1)
    expect(await again!.text()).toBe('console.log(1)')
  })

  it('prefers the precached copy of a font over the runtime cache', async () => {
    sw.fetch.mockImplementation(async () => new Response('precached'))
    await sw.install()

    sw.fetch.mockImplementation(async () => new Response('from the network'))
    const font = await sw.request('/fonts/inter-latin.woff2')

    expect(await font!.text()).toBe('precached')
  })

  it('keeps the asset cache from growing without bound across deploys', async () => {
    sw.fetch.mockImplementation(async () => new Response('chunk'))
    for (let i = 0; i < 65; i++) await sw.request(`/_astro/chunk.${i}.js`)

    const assets = await sw.caches.open('lm-assets')
    expect(assets.store.size).toBe(60)
    // Oldest out first.
    expect(assets.store.has('https://app.test/_astro/chunk.0.js')).toBe(false)
    expect(assets.store.has('https://app.test/_astro/chunk.64.js')).toBe(true)
  })
})

describe('service worker · the block payload', () => {
  let sw: Harness

  beforeEach(() => {
    sw = load()
  })

  it('serves the last payload when the network is gone, and says that it is doing so', async () => {
    sw.fetch.mockResolvedValueOnce(json({ activities: [{ id: 1 }] }))
    const fresh = await sw.request('/api/data')
    expect(fresh!.headers.get('x-lm-stale')).toBe(null)

    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const stale = await sw.request('/api/data')

    // The header is the whole point: "42 km this week" and "42 km the last time this
    // phone had signal" are the same pixels and different facts.
    expect(stale!.headers.get('x-lm-stale')).toBe('1')
    expect(await stale!.json()).toEqual({ activities: [{ id: 1 }] })
  })

  it('gives up rather than inventing one when it has never seen a payload', async () => {
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(sw.request('/api/data')).rejects.toThrow('Failed to fetch')
  })

  it('forgets the block the moment the session is rejected', async () => {
    sw.fetch.mockResolvedValueOnce(json({ activities: [] }))
    await sw.request('/api/data')

    sw.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await sw.request('/api/data')

    // Rotating `APP_PASSWORD` is how this app signs devices out; a device that has been
    // signed out may not keep reading the block from its own cache.
    expect(await sw.caches.keys()).not.toContain(DATA)
  })

  it('never caches an error page as the block', async () => {
    sw.fetch.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await sw.request('/api/data')

    expect((await sw.caches.open(DATA)).store.size).toBe(0)
  })

  /**
   * The captive portal, which is the failure this app is most likely to meet: a hotel, an
   * airport, the station car park. It answers every request with `200` and its own login
   * page, so `response.ok` is true and the body is HTML — and the version of this worker
   * that trusted `ok` alone stored that page under `/api/data` and served it back as the
   * training block.
   */
  it('never caches a captive portal as the block', async () => {
    sw.fetch.mockResolvedValueOnce(json({ activities: [{ id: 1 }] }))
    await sw.request('/api/data')

    sw.fetch.mockResolvedValueOnce(
      new Response('<html>Hotel WiFi</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const answer = await sw.request('/api/data')

    // The stored block is untouched…
    const stored = await (await sw.caches.open(DATA)).match('/api/data')
    expect(await stored!.json()).toEqual({ activities: [{ id: 1 }] })
    // …and what came back is that block, marked stale — a portal is a dead connection
    // wearing a 200, so it takes the same route as one.
    expect(answer!.headers.get('x-lm-stale')).toBe('1')
    expect(await answer!.json()).toEqual({ activities: [{ id: 1 }] })
  })

  it('never caches a sign-in hop as the block', async () => {
    sw.fetch.mockResolvedValueOnce(json({ activities: [{ id: 7 }] }))
    await sw.request('/api/data')

    // What `fetch` hands back after following a 302 to an identity provider: somebody
    // else's 200, with `redirected` as the only thing that still says so.
    const hop = json({ not: 'the block' })
    Object.defineProperty(hop, 'redirected', { value: true })
    sw.fetch.mockResolvedValueOnce(hop)

    const answer = await sw.request('/api/data')
    const stored = await (await sw.caches.open(DATA)).match('/api/data')
    expect(await stored!.json()).toEqual({ activities: [{ id: 7 }] })
    expect(answer!.headers.get('x-lm-stale')).toBe('1')
  })

  it('passes an interception straight through when it has no block to fall back on', async () => {
    sw.fetch.mockResolvedValueOnce(
      new Response('<html>Hotel WiFi</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const answer = await sw.request('/api/data')

    // Nothing to serve and nothing invented: the app sees the portal and reports it.
    expect(answer!.status).toBe(200)
    expect(await answer!.text()).toContain('Hotel WiFi')
    expect((await sw.caches.open(DATA)).store.size).toBe(0)
  })
})

describe('service worker · what it leaves alone', () => {
  let sw: Harness

  beforeEach(() => {
    sw = load()
    sw.fetch.mockResolvedValue(new Response('ok'))
  })

  it('does not touch a mutation', async () => {
    expect(await sw.request('/api/plan/sessions/abc', { method: 'PATCH' })).toBeNull()
    expect(await sw.request('/api/sync', { method: 'POST' })).toBeNull()
  })

  it('does not touch the other endpoints, which have no useful offline answer', async () => {
    expect(await sw.request('/api/sync')).toBeNull()
    expect(await sw.request('/api/activities/12345')).toBeNull()
    expect(await sw.request('/api/strava/connect')).toBeNull()
  })

  it('does not cache itself, which would be a worker that can never be replaced', async () => {
    expect(await sw.request('/sw.js')).toBeNull()
  })

  it('leaves another origin to the browser', async () => {
    expect(await sw.request('https://www.strava.com/api/v3/athlete')).toBeNull()
  })
})
