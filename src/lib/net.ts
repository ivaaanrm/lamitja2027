/**
 * Whether the app is currently reading the network or reading its own memory of it.
 *
 * One boolean, and it lives on `<html>` rather than in React state, because two very
 * different things know the answer and neither of them is a component: the browser's own
 * `online`/`offline` events (wired up in `pwa.ts`, which runs on every page including
 * `/login`) and the service worker's `x-lm-stale` header on a block payload it served
 * from the cache. `navigator.onLine` alone is not enough — it reports the radio, not the
 * internet, so a hotel captive portal is "online" right up until the fetch fails — and a
 * stale payload alone is not enough either, because the very first screen after a
 * connection drops has not fetched anything yet.
 *
 * `ClientRouter` swaps the body and leaves `<html>` alone, so the flag survives a tab tap
 * without anything having to persist it. `src/components/OfflineNotice.astro` is the one
 * thing that reads it, through CSS.
 */
const FLAG = 'data-offline'

export function setOffline(offline: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.toggleAttribute(FLAG, offline)
}

export function isOffline(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.hasAttribute(FLAG)
}
