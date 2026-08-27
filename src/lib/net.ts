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

/**
 * Drops the service worker's copy of `/api/data`.
 *
 * The offline layer keeps the last block payload so the plan survives a dead connection,
 * in a cache scoped to the *origin* — which was exactly right while a deployment was one
 * athlete, and is a leak the moment it is several. Two friends on one laptop, or a phone
 * handed over for a minute: without this, signing in as the second one paints the first
 * one's block from cache before the network answers, and if there is no network it never
 * stops painting it.
 *
 * So it is cleared on the way out *and* on the way in. Out, because a signed-out device
 * should hold nothing; in, because the athlete arriving cannot know what the device was
 * holding before them. `sw.js` also drops it on any 401, which covers the third case —
 * a session that expired rather than ended.
 *
 * Best-effort by design: no Cache API (old browser, private mode) simply means there was
 * no cached payload to leak either.
 */
export async function clearCachedBlock(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('lm-data-')).map((n) => caches.delete(n)))
  } catch {
    // Nothing to do: an unavailable cache is an absent one.
  }
}
