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

let dismissed = false

function hide() {
  dismissed = true
  document.getElementById('boot')?.setAttribute('data-done', '')
}

/** Called once the block is in hand — or once it is known that it is not coming. */
export function bootDone() {
  if (dismissed || typeof document === 'undefined') return
  const remaining = FLOOR_MS - performance.now()
  if (remaining <= 0) {
    hide()
    return
  }
  // Claimed now rather than in the callback, so a second `reload()` landing inside the
  // floor cannot queue a second timer.
  dismissed = true
  setTimeout(hide, remaining)
}
