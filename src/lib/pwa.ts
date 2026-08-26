import { setOffline } from './net'

/**
 * The two things every page does that have nothing to do with what is on it: register the
 * service worker, and keep the offline flag honest.
 *
 * Loaded from `Base.astro` as a bundled module script, which runs once per document — so
 * a tab tap, which swaps the body and keeps the document, does not re-register anything.
 *
 * ---
 *
 * **Only in a production build.** A worker caching a dev server's modules would answer
 * with yesterday's component the first time it got the chance, and the hour spent finding
 * out why is an hour nobody gets back. Worse, a worker registered once during development
 * outlives the session that installed it: it stays on `localhost` until something
 * explicitly removes it, which is what the `unregister` branch below is for.
 */
export function initPwa(): void {
  offlineFlag()
  if (!('serviceWorker' in navigator)) return

  if (!import.meta.env.PROD) {
    // Clears a worker left behind by a previous production preview on the same origin.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister()
    })
    return
  }

  // After `load`, so registering never competes with the first paint for bandwidth on the
  // one launch where the app has nothing cached and every byte is on the critical path.
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then(watchForUpdates, () => {})
  })
}

/**
 * An installed PWA can go weeks without a document load, which is the only moment the
 * browser checks `sw.js` on its own. A deployed fix would then sit on the server while the
 * phone kept running the copy it installed in August.
 *
 * So the check is hung off the app being brought to the foreground instead, throttled to
 * once an hour — it is a conditional GET of one small file, and the browser answers it
 * with a 304 every time but the one that matters.
 */
const UPDATE_EVERY_MS = 60 * 60 * 1000

function watchForUpdates(registration: ServiceWorkerRegistration): void {
  let checkedAt = Date.now()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - checkedAt < UPDATE_EVERY_MS) return
    checkedAt = Date.now()
    void registration.update().catch(() => {})
  })
}

/**
 * The radio's own answer, which is the only signal available before anything has been
 * fetched. `useBlock` overrides it either way the moment a real request settles — a
 * captive portal reports "online" and fails, and a request that succeeds proves the
 * connection whatever `navigator.onLine` believes.
 */
function offlineFlag(): void {
  setOffline(!navigator.onLine)
  addEventListener('online', () => setOffline(false))
  addEventListener('offline', () => setOffline(true))
}
