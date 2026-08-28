/**
 * The launch screen's exit — the other half of `src/components/Boot.astro`, which owns the
 * overlay itself and its 2.6s dead-man switch.
 *
 * One rule, in one place: the app is open when the *first* `/api/data` has settled. Not
 * when the shell painted (it paints empty), not when React hydrated (it hydrates into
 * skeletons), and not on a timer picked to look right — the block is what every screen is
 * made of, so the moment it is in hand is the moment there is something to show. A failed
 * fetch counts as settled too: what replaces the overlay there is an error card with a
 * retry on it, which is a screen you can act on rather than one to keep hiding.
 *
 * The floor is the only number here. Data cached at the edge can land in under 100ms, and
 * a mark that flashes half-drawn and disappears is a flicker where a splash was meant to
 * be — so nothing is dismissed inside the first 480ms, measured from the page opening
 * rather than from this call, which is what keeps a fast launch and a slow one feeling
 * like the same app. Past that the dismissal is immediate: the floor never *adds* to a
 * wait, it only refuses to cut one short.
 *
 * Import-safe during prerender: this module is pulled in by `useBlock`, which is rendered
 * in a Worker at build time (gotcha 15), so nothing here touches `document` until it is
 * called — and it is only ever called from inside an effect.
 */
const FLOOR_MS = 480

function hide(el: Element) {
  el.setAttribute('data-done', '')
}

/**
 * Called once the block is in hand — or once it is known that it is not coming.
 *
 * The "already dismissed" state lives on the `#boot` node, not in a module variable. That
 * used to be load-bearing against a real bug — `ClientRouter` kept this module's realm
 * alive across a client-side navigation while the overlay node did not survive a hop
 * through `/ajustes`, which carried none of its own, so a module-level latch left the app
 * stuck behind a *fresh* overlay it thought it had already dismissed. Every screen is one
 * document now and there is no hop to break, but the node is still the right place for
 * the answer: it is the thing being dismissed, and `reload()` may call this again long
 * after the first launch.
 */
export function bootDone() {
  if (typeof document === 'undefined') return
  const el = document.getElementById('boot')
  // Nothing to hide, already hidden, or a hide already scheduled for this node.
  if (!el || el.hasAttribute('data-done') || el.hasAttribute('data-dismissing')) return
  // `performance.now()` counts from the original document load, not from this navigation,
  // so the floor only ever delays the cold start — later arrivals clear it at once.
  const remaining = FLOOR_MS - performance.now()
  if (remaining <= 0) {
    hide(el)
    return
  }
  // Marked on the node rather than in a closure, so a second `reload()` landing inside the
  // floor cannot queue a second timer.
  el.setAttribute('data-dismissing', '')
  setTimeout(() => hide(el), remaining)
}
