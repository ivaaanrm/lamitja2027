/**
 * The offline layer.
 *
 * This app is opened at a trailhead, in a car park, on a platform under a station — the
 * places a phone has one bar or none — and until now every one of those launches ended on
 * the browser's own error page, inside a window with no address bar to retry from. A
 * training plan you cannot read on the morning you are meant to run it is not a training
 * plan. So: the shell is cached as it is visited, the build's hashed assets are cached the
 * first time they are asked for, and the last `/api/data` payload is kept so the block
 * itself survives a dead connection.
 *
 * **Five caches, and the split between them is the whole design.**
 *
 *   `lm-core`   Precached at install: the two fonts, the mark, the manifest. Stable URLs
 *               whose bytes only change when the design does, so they are safe to serve
 *               cache-first forever — which is exactly why `VERSION` has to move when one
 *               of them is edited.
 *   `lm-pages`  The prerendered shells, keyed by *pathname* with the query thrown away.
 *               `/actividad?id=1` and `/actividad?id=2` are the same document, and storing
 *               one entry per run would put a hundred and fifty copies of one file in the
 *               cache.
 *   `lm-assets` `/_astro/*`, deliberately *not* versioned. Every filename in there carries
 *               a content hash, so an entry can never be stale — it can only be surplus,
 *               which is what the trim below is for. Purging it on a service-worker update
 *               would throw away a perfectly good copy of a file that is still current.
 *   `lm-media`  The exercise illustrations from `/api/exercises/img/…`. Unversioned for the
 *               same reason as `lm-assets` — the catalogue generation is in the URL, so an
 *               entry can only be surplus — and a cache of its *own* rather than a corner
 *               of `lm-assets`, because one browse through the exercise picker is fifty
 *               thumbnails and would evict every chunk of the running build from an LRU of
 *               sixty. Two working sets, two caches.
 *   `lm-data`   One entry: the last block payload that came back 200.
 *
 * **Network-first for anything that can change, cache-first for anything that cannot.**
 * `/api/data` goes to the network and falls back to the cache, so a fresh sync is never
 * hidden behind a stale copy. Hashed assets and precached fonts go the other way, because
 * a hash *is* the version. The block payload is never stale-while-revalidate: that would
 * hand the phone yesterday's plan while today's was still in flight, and this is an app
 * whose entire content is "what am I doing today".
 *
 * **The shells sit in between, and they are network-first.** A shell request is now always
 * a real navigation — a launch, a reload, a link from outside — so it always goes to the
 * network first: the document that boots the app has to be the current build, or it points
 * at hashed chunks a deploy has since removed and opens to nothing.
 *
 * There used to be a second route through here, answering from the cache and revalidating
 * behind it, because a tab tap was a `ClientRouter` swap fetching the next shell and
 * network-first put a round trip in front of every one of them. The four tabs are one
 * document now (`src/components/Shell.tsx`): a tab tap fetches nothing at all, and the only
 * thing left asking for a shell is the browser. The split, and the two functions that told
 * the two callers apart, went with it.
 *
 * One consequence worth knowing, because it is an improvement rather than a compromise. A
 * device that has only ever launched `/` now has only `/` in `lm-pages` — the other shells
 * are never requested, so they are never cached. Opening `/plan` offline therefore falls
 * back to the `/` document, and *that is the right answer*: the shell reads the real
 * `location` as it hydrates, so it opens on the plan. It used to open on Hoy.
 *
 * **The payload cache holds one athlete's private training data**, in an origin-scoped
 * store on that athlete's own phone — the same footing as a session cookie. It is dropped
 * the moment `/api/data` answers 401, so a device that has been signed out (by rotating
 * `APP_PASSWORD`, which is how this app signs devices out) cannot keep reading the block
 * offline.
 *
 * There is no build step behind this file and it is not generated: shells are cached as
 * they are visited rather than precached, so a deploy can never leave a stale shell
 * pointing at a hashed chunk that no longer exists.
 *
 * **Bump `VERSION` when something already stored has to be thrown away** — the precache
 * list changed, or a rule changed what one of the versioned caches is allowed to hold.
 * That is what the bump *does*: `activate` deletes every `lm-` cache not in `KEEP`, which
 * is the shells, the core files and the block payload on every device. Adding an
 * unversioned cache with rules of its own is not that — `lm-media` joined this file with
 * `VERSION` untouched, because purging three good caches to introduce a fourth one would
 * cost every phone its offline copy of the block to gain nothing. The browser
 * byte-compares this file, so any edit ships a new worker either way.
 */

const VERSION = 'v5'

const CORE = `lm-core-${VERSION}`
const PAGES = `lm-pages-${VERSION}`
const DATA = `lm-data-${VERSION}`
/** Unversioned on purpose: content-hashed filenames cannot go stale. */
const ASSETS = 'lm-assets'
/**
 * The exercise illustrations. Unversioned for the same reason — the catalogue generation
 * is a segment of the URL, so a stored entry is either current or surplus, never stale.
 * Not private data either: every athlete on the deployment gets the same pictures, so this
 * one is not dropped on a 401 the way `lm-data` is.
 */
const MEDIA = 'lm-media'

const KEEP = new Set([CORE, PAGES, DATA, ASSETS, MEDIA])

/**
 * The handful of files with stable URLs and no hash in them. Everything else the app
 * needs is cached the first time it is asked for, which is what keeps this list from
 * having to know anything about the build.
 */
const PRECACHE = [
  '/fonts/inter-latin.woff2',
  '/fonts/manrope-latin.woff2',
  '/fonts/schibsted-grotesk-latin.woff2',
  '/favicon.svg',
  '/icon-192.png',
  '/manifest.webmanifest',
]

/** Roughly two deploys' worth of chunks, plus room. Oldest entry out first. */
const MAX_ASSETS = 60

/**
 * Several templates' worth of exercises, at the measured 16.5 KB average — about 2.5 MB.
 * Enough that the moves an athlete actually trains stay on the phone, small enough that
 * browsing the picker cannot turn into a 16 MB download of somebody else's catalogue.
 */
const MAX_MEDIA = 150

/** The one payload worth keeping, under one key. */
const DATA_KEY = '/api/data'

/**
 * The mirrored exercise illustrations, and the one `/api/` path with an offline answer
 * besides the block itself.
 *
 * They are safe to serve cache-first forever: the catalogue generation is in the path, so
 * a re-vendored catalogue asks for different URLs rather than for different bytes under
 * the same ones — the avatar rule, generalised. `/api/exercises` (the *search*) is not in
 * here and is left to the network like every other read: a picker with no signal has
 * nothing useful to answer with, and a template renders offline from the Spanish name it
 * was prescribed under rather than from the catalogue.
 */
const MEDIA_PREFIX = '/api/exercises/img/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE)
      // One at a time rather than `addAll`, which rejects the whole install if a single
      // file 404s — and an install that fails is a worker that never activates at all.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Lets the browser fire the navigation request in parallel with booting this
      // worker, so adding offline support cannot cost a page load its first byte.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {})
      }
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name.startsWith('lm-') && !KEEP.has(name)).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // A POST is a mutation and a cache is not where one goes. Everything else here reads.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never intercept the worker itself: a cached copy of this file is a worker that can
  // never be replaced.
  if (url.pathname === '/sw.js') return

  if (url.pathname === DATA_KEY) {
    event.respondWith(blockData(event))
    return
  }
  // Before the blanket `/api/` pass-through below, for the same reason `/api/data` is:
  // these are the two endpoints under `/api/` that have an offline answer, and the
  // general rule would otherwise swallow this one.
  if (url.pathname.startsWith(MEDIA_PREFIX)) {
    event.respondWith(media(event, request))
    return
  }
  // Every other endpoint is a mutation, an OAuth hop or a one-shot read of Strava's
  // record. None of them have a useful offline answer, so they are left alone.
  if (url.pathname.startsWith('/api/')) return

  if (isDocument(request)) {
    event.respondWith(page(event, url))
    return
  }
  if (isStatic(url)) {
    event.respondWith(asset(event, request))
  }
})

/**
 * Is the browser asking for one of this app's own documents?
 *
 * The three signals are what a real navigation carries, and a real navigation is the only
 * thing that asks for a shell any more. This used to be two functions with a wider net
 * under them — a tab tap was a `ClientRouter` swap and a prefetch was a `<link>`, and
 * neither carries a navigate mode, a document destination or an `Accept: text/html`, so
 * both had to be caught by "same-origin GET with no file extension" instead. Both are
 * gone: the tabs share one document and prefetching is off (`astro.config.mjs`).
 */
function isDocument(request) {
  if (request.mode === 'navigate' || request.destination === 'document') return true
  return (request.headers.get('accept') ?? '').includes('text/html')
}

function isStatic(url) {
  return (
    url.pathname.startsWith('/_astro/') ||
    url.pathname.startsWith('/fonts/') ||
    /\.(?:js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname)
  )
}

/**
 * The app shell for one route.
 *
 * Keyed on the pathname alone: `/actividad` and `/sesion` are one prerendered document
 * each, addressed by a query string the server never reads, so caching per URL would
 * store the same file once per activity in the log.
 *
 * Network-first, and only ever network-first: every request that reaches here is a
 * launch, a reload or a link from outside — the request that *boots* the app — so it has
 * to be the current build. A stale shell served here would ask for `/_astro/*` chunks that
 * the last deploy removed, and what that looks like is an app that opens to nothing. It
 * costs a round trip once per launch and nothing per tab tap, because a tab tap no longer
 * asks for a document at all.
 */
async function page(event, url) {
  const key = new Request(`${url.origin}${url.pathname}`)
  const cache = await caches.open(PAGES)

  try {
    const preloaded = await event.preloadResponse
    const response = preloaded || (await fetch(event.request))
    // `redirected` for the same reason `/api/data` checks it: a portal or a sign-in hop
    // ends in somebody else's 200, and storing that would pin their page to this route.
    if (response.ok && !response.redirected) event.waitUntil(cache.put(key, response.clone()))
    return response
  } catch {
    const hit = await cache.match(key)
    if (hit) return hit
    // A route never opened on this device, with no connection to open it now. `/` is the
    // one shell that is always there — the app was installed from it — and it is not a
    // consolation prize: every screen lives in that document, and the shell reads the real
    // `location` as it hydrates, so `/plan` served this way still opens on the plan.
    const home = await cache.match(new Request(`${url.origin}/`))
    return home ?? offlinePage()
  }
}

/** A hashed file, or one of the stable ones. Both are safe to answer from the cache. */
async function asset(event, request) {
  const core = await caches.open(CORE)
  const precached = await core.match(request)
  if (precached) return precached

  const cache = await caches.open(ASSETS)
  const hit = await cache.match(request)
  if (hit) return hit

  const response = await fetch(request)
  if (response.ok && !response.redirected) {
    event.waitUntil(
      cache.put(request, response.clone()).then(() => trim(cache)),
    )
  }
  return response
}

/**
 * One exercise illustration, cache-first.
 *
 * Same shape as `asset()` and for the same reason: the URL carries the catalogue
 * generation, so the bytes under it cannot change, and the route that serves it says so
 * with `immutable`. What is different is the cache it lands in — see `MEDIA` above — and
 * that nothing precached ever stands in front of it.
 *
 * Cached best-effort and only what this device has actually shown: 16 MB of illustrations
 * is not something to push onto anyone's phone at install. So a template screen has to
 * render text-first with the picture as an enhancement, which is the avatar rule again —
 * the name is the content and the tile is decoration.
 */
async function media(event, request) {
  const cache = await caches.open(MEDIA)
  const hit = await cache.match(request)
  if (hit) return hit

  const response = await fetch(request)
  // `redirected` for the same reason everywhere else in this file: a portal's 200 is not
  // an illustration, and storing it under an immutable URL would pin it there.
  if (response.ok && !response.redirected) {
    event.waitUntil(cache.put(request, response.clone()).then(() => trim(cache, MAX_MEDIA)))
  }
  return response
}

/**
 * Is this the block, or something standing in front of it?
 *
 * `response.ok` is not the question. A captive portal — hotel, airport, the station this
 * app is opened at — answers *every* request with `200` and its own login page, and an
 * identity provider in front of the origin does the same after a session expires. Both
 * are a 200 with an HTML body, and caching either one under `/api/data` would put a login
 * page where the training block goes and then serve it, offline, for as long as the cache
 * survived.
 *
 * Two signals, and both are needed. `redirected` catches the interception that announces
 * itself with a 302 (`fetch` follows it and the `ok` at the end is the portal's, not
 * ours). The content type catches the one that does not bother — a portal that simply
 * answers in place with `200 text/html`.
 */
function isBlockPayload(response) {
  if (response.redirected) return false
  return (response.headers.get('content-type') ?? '').includes('application/json')
}

/** The stored block, marked as what it is. `null` when this phone has never held one. */
async function lastKnownBlock(cache) {
  const hit = await cache.match(DATA_KEY)
  if (!hit) return null

  const headers = new Headers(hit.headers)
  headers.set('x-lm-stale', '1')
  return new Response(hit.body, { status: 200, statusText: 'OK', headers })
}

/**
 * The block, and the one thing in here worth going offline for.
 *
 * A stale copy is served with a header on it rather than silently, because the difference
 * between "you have run 42 km this week" and "you had run 42 km the last time this phone
 * had signal" is the difference between a number and a lie. `src/lib/net.ts` reads it and
 * the app says so on screen.
 *
 * A portal's login page takes the same route as a dead connection, which is what it
 * actually is: the radio is up, the internet is not. Serving the last block with
 * `x-lm-stale` on it is both the honest answer and the useful one.
 */
async function blockData(event) {
  const cache = await caches.open(DATA)

  try {
    const response = await fetch(event.request)

    if (response.ok && isBlockPayload(response)) {
      event.waitUntil(cache.put(DATA_KEY, response.clone()))
      return response
    }
    if (response.status === 401) {
      // Signed out — on this device or on every device, by rotating the password. Either
      // way this copy of the block stops being something this phone may read.
      event.waitUntil(caches.delete(DATA))
      return response
    }
    // A 200 that is not the block is an interception; anything else is a real error the
    // app should see and say. Neither is ever written to the cache.
    if (response.ok) return (await lastKnownBlock(cache)) ?? response
    return response
  } catch (cause) {
    const hit = await lastKnownBlock(cache)
    if (!hit) throw cause
    return hit
  }
}

/** Oldest first — `cache.keys()` answers in insertion order. */
async function trim(cache, max = MAX_ASSETS) {
  const keys = await cache.keys()
  if (keys.length <= max) return
  await Promise.all(keys.slice(0, keys.length - max).map((key) => cache.delete(key)))
}

/**
 * The last resort: a route this device has never opened, with nothing cached to stand in
 * for it. In practice unreachable — the app is installed by visiting `/`, which caches it
 * — but "in practice unreachable" is not the same as unreachable, and what it replaces is
 * the browser's own error page inside a window with no address bar.
 *
 * Written out here rather than built from the design tokens because a service worker
 * cannot import the stylesheet, and a screen whose whole job is to appear when nothing
 * else loaded may not depend on anything else loading. Two colours, and they are
 * `--color-surface` and `--color-label`.
 *
 * Nameless for the same reason. Everything else a person reads in this app takes its name
 * from `config.ts`, but `public/` is copied verbatim into the build and never sees a
 * build-time value — so this screen says *Sin conexión* and stops, rather than greeting a
 * fork with the author's race.
 */
function offlinePage() {
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
      // No app name: this file is copied byte-for-byte out of `public/`, so it is the one
      // string in the app that cannot read `config.ts`. A title that named the wrong race
      // would be worse than a title that names none, and the sentence below says the rest.
      `<title>Sin conexión</title>` +
      `<style>html{background:#13151a}body{margin:0;min-height:100dvh;display:grid;place-items:center;` +
      `padding:2rem;background:#13151a;color:#f7f8fa;font-family:Inter,system-ui,sans-serif;text-align:center}` +
      `h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0;font-size:.8125rem;line-height:1.5;` +
      `color:rgba(247,248,250,.68)}a{display:inline-block;margin-top:1.25rem;padding:.75rem 1.25rem;` +
      `border-radius:.75rem;background:#18c49a;color:#13151a;font-size:.8125rem;font-weight:600;` +
      `text-decoration:none}</style></head><body><main><h1>Sin conexión</h1>` +
      `<p>Esta pantalla todavía no se había abierto en este teléfono, así que no hay ninguna copia` +
      ` guardada de ella. Vuelve a intentarlo cuando tengas cobertura.</p>` +
      `<a href="/">Volver a Hoy</a></main></body></html>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}
