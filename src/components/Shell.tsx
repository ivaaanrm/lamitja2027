import { Activity } from 'react'
import { ROUTES, documentTitle, type RouteMeta } from '@/lib/nav'
import { useDocumentTitle, useRoute, type Route } from './router'
import { ActivityDetail } from './ActivityDetail'
import { Dashboard } from './Dashboard'
import { Dock } from './Dock'
import { Planner } from './Planner'
import { Progress } from './Progress'
import { SessionDetail } from './SessionDetail'
import { Settings } from './Settings'
import { TrainingLog } from './TrainingLog'
import { HeaderAvatar } from './useBlock'
import { cn } from '@/lib/cn'

/**
 * The whole app, in one React root and one document.
 *
 * Every screen behind the dock used to be its own prerendered page, swapped in by Astro's
 * `ClientRouter`. That cost a React teardown and a full rehydrate per tab tap, against a
 * shell whose HTML is skeletons — see the header of `src/components/router.tsx` for what
 * that looked like on a phone and why no amount of CSS could fix it. Here the four tabs
 * and the three screens reached from inside them are components of one tree, the block is
 * read once for the life of the document, and a tab tap is a `setState`.
 *
 * `src/pages/*.astro` still emits one prerendered document per route, and each one renders
 * *this*, with its own path. That is what keeps a cold start, a deep link and a reload
 * opening on the right screen with real HTML in the first paint — the shell is one
 * document at a time, not a single-page app that has to boot before it can route.
 *
 * ---
 *
 * **The four tabs stay mounted; the other three do not.** `<Activity>` (React 19.2) keeps a
 * hidden tab's state and DOM while unmounting its effects, which is precisely the
 * behaviour a native tab bar has and precisely what a document swap could never give:
 * `/plan` keeps the week you had open, `/registro` keeps its filter, and both keep their
 * scroll offset (`router.tsx` holds the offsets, since the page scrolls the document
 * rather than a box inside it). Hidden children are not server-rendered and are rendered
 * at a lower priority than the visible one, so this costs the cold start nothing and makes
 * every tap after the first free.
 *
 * `/sesion`, `/actividad` and `/ajustes` are mounted only while they are open. They are
 * addressed by a query string or carry a form, so state held across a close would be state
 * belonging to the last session, the last run or an edit nobody submitted.
 *
 * **The header is here rather than in the layout** because it changes with the route and
 * the layout is prerendered once. Same for the title: the browser is never told about a
 * `pushState`, so `useDocumentTitle` says it.
 */
const TABS_SCREENS = [
  { path: '/', Screen: Dashboard },
  { path: '/plan', Screen: Planner },
  { path: '/progreso', Screen: Progress },
  { path: '/registro', Screen: TrainingLog },
] as const

export function Shell({ path }: { path: string }) {
  const route = useRoute(path)
  const meta = ROUTES[route.path]
  useDocumentTitle(documentTitle(route.path))

  return (
    <>
      <main
        className={cn(
          'mx-auto flex min-h-full max-w-lg flex-col gap-2 px-gutter pt-3',
          // A screen with no dock under it does not have to clear one.
          meta.tab ? 'pb-[calc(var(--dock-h)+1.25rem)]' : 'pb-[calc(2rem+env(safe-area-inset-bottom))]',
        )}
      >
        <Header meta={meta} />
        <OfflineNotice />
        <Screens route={route} />
      </main>
      {meta.tab ? <Dock tab={meta.tab} /> : null}
    </>
  )
}

/**
 * The top row: the screen's name, and the signed-in athlete's initials linking to their
 * settings.
 *
 * Two shapes rather than one, because `/ajustes` is the screen the avatar *goes to* — it
 * gets a way back instead of a way in, and it is the only screen in the app that is not
 * under a tab.
 */
function Header({ meta }: { meta: RouteMeta }) {
  if (meta.header === false) return null

  if (meta.back) {
    return (
      <header className="px-0.5 pb-0.5">
        <a
          href={meta.back.href}
          className="tappable -ml-1 inline-flex min-h-11 w-fit items-center gap-1 px-1 text-caption font-medium text-label-2"
        >
          <span aria-hidden="true">←</span> {meta.back.label}
        </a>
        <h1 className="mt-1 font-display text-title2 font-bold tracking-tight text-label">
          {meta.heading}
        </h1>
      </header>
    )
  }

  return (
    <header className="flex items-start justify-between gap-2 px-0.5 pb-0.5">
      <div className="min-w-0">
        {meta.heading ? (
          <h1 className="font-display text-title2 font-bold tracking-tight text-label">
            {meta.heading}
          </h1>
        ) : null}
        {meta.sub ? (
          <p className="mt-0.5 text-footnote leading-relaxed text-label-2">{meta.sub}</p>
        ) : null}
      </div>
      <HeaderAvatar />
    </header>
  )
}

function Screens({ route }: { route: Route }) {
  return (
    <>
      {TABS_SCREENS.map(({ path, Screen }) => (
        <Activity key={path} mode={route.path === path ? 'visible' : 'hidden'}>
          <Screen />
        </Activity>
      ))}
      {route.path === '/sesion' ? <SessionDetail route={route} /> : null}
      {route.path === '/actividad' ? <ActivityDetail route={route} /> : null}
      {route.path === '/ajustes' ? <Settings /> : null}
    </>
  )
}

/**
 * The one line that stops a cached block from being a lie.
 *
 * With a service worker in front of `/api/data`, a phone with no signal no longer gets an
 * error card — it gets the block, exactly as it looked the last time there was a
 * connection. That is the right answer at a trailhead and the wrong one to leave
 * unlabelled: "42 km esta semana" and "42 km the last time this phone had signal" are the
 * same pixels and different facts, and the sync stamp at the foot of `/` is three cards
 * away.
 *
 * Always in the tree and hidden by CSS on `html[data-offline]` — `src/lib/net.ts` owns the
 * flag and two things set it: the browser's `offline` event, and a block payload the
 * worker answered from its cache. Nothing here costs a render when there is a connection.
 *
 * In flow rather than pinned. It pushes the cards down by one line when it appears, which
 * is a layout shift and is the honest one: an overlay above the dock would cover the row
 * a thumb is reaching for, and a state that changes what every number below it means is
 * not chrome to be floated over the top.
 *
 * `role="status"`: it is polite, it is announced once, and it is never the only carrier —
 * amber is the qualifier hue in this app, and the sentence says the whole thing in words.
 */
function OfflineNotice() {
  return (
    <p
      id="offline-notice"
      role="status"
      className="flex items-center gap-2 rounded-xl bg-amber/12 px-3 py-2 text-caption leading-relaxed text-amber"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber" />
      Sin conexión. Estás viendo el bloque tal y como estaba en la última sincronización.
    </p>
  )
}
