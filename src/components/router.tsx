import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { ROUTES, normalizePath } from '@/lib/nav'

/**
 * The router, and the reason this app stopped stuttering on a phone.
 *
 * **What it replaced.** Every tab used to be its own document. Astro's `ClientRouter`
 * fetched the next shell, swapped the `<body>`, and the React root went with it — so a tab
 * tap tore down a nine-thousand-line tree and built it again from nothing. And it could
 * not build it from the block: the prerendered shell ships *skeletons*, so `useBlock`'s
 * `getServerSnapshot` has to return the empty payload or hydration is a mismatch. The
 * first paint of the incoming tab was therefore grey bars, by construction, with the real
 * data one render behind it — and `::view-transition-new` is *live*, so the skeleton→data
 * swap happened in the middle of the 220ms cross-fade. Content, skeleton, content, on
 * every tap, with the payload sitting in memory the whole time.
 *
 * Nothing about that was fixable from the outside: the shells were being animated between,
 * and one of them was always empty. So the four tabs (and the three screens reached from
 * inside them) are **one document** now. A tab tap is a `setState`.
 *
 * **Why the transition is real now.** `document.startViewTransition` captures the *new*
 * state when its callback settles. The callback here is a `flushSync`, so React has
 * rendered the next screen — with the block, from the store, on its first render —
 * before the browser looks. Both snapshots are real content. That is the whole difference
 * between this and what came before, and it is why the `flushSync` is not negotiable:
 * without it React would schedule the render on its own (a `MessageChannel` task, so a
 * turn later), the snapshot would be taken of a page that had not changed yet, and the
 * animation would run backwards through an empty frame.
 *
 * **Links are intercepted, not rewritten.** There are several dozen `<a href="/sesion?…">`
 * in the screens and none of them had to change: one delegated listener checks the path
 * against `ROUTES` and swallows the click only if it names a screen this shell renders.
 * Everything else — `/login`, `/bienvenida`, `/alta`, `/api/strava/connect` — falls
 * through to a real navigation, which is right: those are doors out of the app, not
 * screens in it.
 *
 * This file is under `src/components/` rather than `src/lib/` because it imports
 * `react-dom`. The part that is pure — which paths exist, what each is called — is
 * `src/lib/nav.ts`, and is unit-testable without a DOM.
 */
export interface Route {
  /** Always a key of `ROUTES`. */
  path: string
  /** Including the `?`, or empty. */
  search: string
  /**
   * Whether this came from the real URL or from the prerendered shell.
   *
   * `false` for exactly one render: the hydration pass, where the only honest answer is
   * what the HTML being hydrated says — and a prerendered document knows its path but
   * never its query string. `/sesion?id=w03-tue-1` is one shell for every session, so a
   * screen that read the id straight off `location` during hydration would disagree with
   * the markup it was adopting. The screens read `live` and hold their "not known yet"
   * state until it turns true, which is the same tri-state they used to get from an
   * effect — except that on a hop *within* the shell it is true on the first render, so
   * opening a session no longer costs a frame of the dead-end card.
   */
  live: boolean
}

const listeners = new Set<() => void>()

/**
 * The current route, as one object whose identity only changes when the route does —
 * `useSyncExternalStore` re-renders forever otherwise.
 *
 * `null` until first read, which is what keeps this module import-safe during the
 * prerender pass: it is pulled into a Worker with no `location` at build time (AGENTS
 * gotcha 15), and nothing here touches one until a component actually subscribes.
 */
let current: Route | null = null

function make(path: string, search: string, live: boolean): Route {
  // An unknown path can only arrive one way: the service worker answering a route this
  // device has never cached with the `/` shell it does have. Landing on Hoy beats landing
  // on a blank column.
  return { path: ROUTES[path] ? path : '/', search, live }
}

function readSnapshot(): Route {
  current ??= make(normalizePath(location.pathname), location.search, true)
  return current
}

/** Where each route was left. Cleared with the document, like everything else here. */
const scrollOffsets = new Map<string, number>()

const offsetKey = (route: Route) => route.path + route.search

function rememberScroll(route: Route): void {
  scrollOffsets.set(offsetKey(route), window.scrollY)
}

/**
 * Whether to animate at all.
 *
 * `ClientRouter` used to ship the reduced-motion guard for the whole app; it is gone, so
 * the check is here. Skipping the transition entirely rather than zeroing its duration is
 * the stronger answer: no snapshots are taken, so there is nothing to fade.
 */
function animates(): boolean {
  return (
    typeof document.startViewTransition === 'function' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Move to a route that history already agrees with.
 *
 * The scroll is placed in two halves around the render, and the split is load-bearing. A
 * route being opened for the first time is put at the top *before* React renders it, so a
 * screen that positions itself on mount — `Planner` scrolls to the current week, and
 * checks `window.scrollY` first so it never yanks a restored offset — reads the offset it
 * is landing on rather than the one it is leaving. A route being returned to is restored
 * *after*, because its offset is only a valid scroll target once its content is back in
 * the document and the page is tall enough to hold it.
 */
function commit(next: Route): void {
  const remembered = scrollOffsets.get(offsetKey(next))

  const swap = () => {
    if (remembered === undefined) window.scrollTo(0, 0)
    flushSync(() => {
      current = next
      for (const listener of listeners) listener()
    })
    if (remembered !== undefined) window.scrollTo(0, remembered)
  }

  if (!animates()) {
    swap()
    return
  }
  document.startViewTransition(swap)
}

/**
 * Go to a screen this shell renders. Anything else belongs to the browser — see the click
 * handler, which is the only caller that ever passes something it has not already checked.
 */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  const url = new URL(href, location.href)
  const path = normalizePath(url.pathname)
  const now = readSnapshot()

  // Tapping the tab you are already on scrolls it back to the top, which is what a native
  // tab bar does and the only way back up a several-thousand-pixel log.
  if (path === now.path && url.search === now.search) {
    if (window.scrollY > 0) {
      window.scrollTo({ top: 0, behavior: animates() ? 'smooth' : 'auto' })
    }
    return
  }

  rememberScroll(now)
  const entry = url.pathname + url.search + url.hash
  history[options.replace ? 'replaceState' : 'pushState'](null, '', entry)
  commit(make(path, url.search, true))
}

/** Is this a plain left-click on an ordinary in-app link, or something the browser owns? */
function handles(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null

  const anchor = (event.target as Element | null)?.closest?.('a')
  if (!anchor || anchor.hasAttribute('download')) return null
  // The escape hatch, for a link that has to leave this document on purpose.
  if (anchor.hasAttribute('data-reload')) return null
  if ((anchor.getAttribute('rel') ?? '').includes('external')) return null

  const target = anchor.getAttribute('target')
  if (target && target !== '_self') return null

  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#')) return null

  const url = new URL(href, location.href)
  if (url.origin !== location.origin) return null
  if (!ROUTES[normalizePath(url.pathname)]) return null

  return url.href
}

let installed = false

/**
 * Installed once, on the first subscriber, and never removed — these belong to the
 * document rather than to a component, and there is exactly one shell in it.
 */
function install(): void {
  if (installed) return
  installed = true

  // Ours to place, in `commit`. Left on `auto` the browser also restores an offset of its
  // own on a back navigation, a frame after we have set one.
  history.scrollRestoration = 'manual'

  document.addEventListener('click', (event) => {
    const href = handles(event)
    if (!href) return
    event.preventDefault()
    navigate(href)
  })

  addEventListener('popstate', () => {
    const next = make(normalizePath(location.pathname), location.search, true)
    const now = readSnapshot()
    if (next.path === now.path && next.search === now.search) return
    rememberScroll(now)
    commit(next)
  })
}

function subscribe(listener: () => void): () => void {
  install()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The current route.
 *
 * `prerenderedPath` is what the `.astro` page this document was built from renders, and it
 * is the server snapshot: React uses it for the hydration render so the first client tree
 * matches the HTML, then adopts the real URL in the layout effect that runs immediately
 * after, before the frame is painted. Exactly the shape `useBlock` uses, and for exactly
 * the same reason.
 */
export function useRoute(prerenderedPath: string): Route {
  const prerendered = useMemo(() => make(prerenderedPath, '', false), [prerenderedPath])
  return useSyncExternalStore(subscribe, readSnapshot, () => prerendered)
}

/** The query string, parsed, or `null` while the shell is still hydrating. */
export function useRouteParams(route: Route): URLSearchParams | null {
  return useMemo(() => (route.live ? new URLSearchParams(route.search) : null), [route])
}

/** Keeps the tab title honest across a hop the browser was never told about. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title
  }, [title])
}
