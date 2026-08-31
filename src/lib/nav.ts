import { APP_NAME } from './config'

/**
 * Every place this app goes, and everything the shell needs to know about each one.
 *
 * The four tabs are the dock; the three below them are screens reached from inside a tab.
 * All seven live in **one document** — `src/components/Shell.tsx` is the single React root
 * that renders whichever one the URL names, and `src/components/router.tsx` moves between
 * them with `history.pushState` rather than with a navigation. This table is what both of
 * them read, and it is also what every `.astro` page under `src/pages` passes to
 * `App.astro` so the prerendered HTML opens on the right screen.
 *
 * It is pure and it imports nothing but `config.ts`, because it is read in four places:
 * the prerender pass, the client bundle, the router's link interception, and the dock.
 *
 * **A path that is not in here is not ours.** The router's click handler checks this table
 * before swallowing a click, so `/login`, `/alta`, `/bienvenida` and `/api/*` stay real
 * navigations — they are entry and exit doors rather than screens, and a fresh document is
 * the honest thing to hand someone crossing one.
 */

/** The dock, in the order it is drawn. */
export const TABS = [
  { key: 'today', href: '/', label: 'Hoy' },
  { key: 'plan', href: '/plan', label: 'Plan' },
  { key: 'progress', href: '/progreso', label: 'Progreso' },
  { key: 'log', href: '/registro', label: 'Registro' },
] as const

export type Tab = (typeof TABS)[number]['key']

export interface RouteMeta {
  /**
   * Which dock entry lights up — and, because a screen outside the four is a screen
   * outside the bar, `null` is also what hides the dock and gives the page back the room
   * it was reserving underneath.
   */
  tab: Tab | null
  /** The document title, minus the app name. `null` on the tab the app opens on. */
  title: string | null
  /** The `<h1>`. Empty on a screen that says its own name inside the island. */
  heading: string
  sub?: string
  /** `false` where the screen owns the whole top row because its navigation is interactive. */
  header?: boolean
  /** The one screen with no tab under it needs a way back that is not the dock. */
  back?: { href: string; label: string }
}

export const ROUTES: Record<string, RouteMeta> = {
  // The heading is said inside the island: `RaceCountdown` reads the signed-in athlete's
  // own block, which a prerendered shell cannot know.
  '/': { tab: 'today', title: null, heading: '' },
  // `Planner`'s own header carries the week count and the Semanas/Análisis switch.
  '/plan': { tab: 'plan', title: 'Plan', heading: '', header: false },
  '/progreso': {
    tab: 'progress',
    title: 'Progreso',
    heading: 'Progreso',
    sub: 'Evolución del bloque, semana a semana',
  },
  '/registro': {
    tab: 'log',
    title: 'Registro',
    heading: 'Registro',
    sub: 'Todo lo corrido dentro del bloque',
  },
  // A session belongs to the plan wherever it was tapped from, and a run to the log.
  '/sesion': { tab: 'plan', title: 'Sesión', heading: 'Sesión' },
  '/actividad': { tab: 'log', title: 'Actividad', heading: 'Actividad' },
  // The strength library. Under the plan tab rather than under a fifth dock entry: a
  // template is not a place you go, it is something you stamp onto a Monday — reached from
  // `/ajustes` and from the session sheet's own Plantilla field, both of which are inside
  // the plan already.
  '/plantillas': {
    tab: 'plan',
    title: 'Plantillas',
    heading: 'Plantillas',
    sub: 'Fuerza y movilidad, listas para aplicar al plan',
  },
  // One editor for every template, addressed by `?id=` — and by no id at all for a new
  // one, the same way `/sesion` is one shell for every session.
  '/plantilla': { tab: 'plan', title: 'Plantilla', heading: 'Plantilla' },
  // Reached from the initials in the header on every tab, never from the dock — so no tab
  // lights, the bar goes, and the way out is a chevron of its own.
  '/ajustes': {
    tab: null,
    title: 'Ajustes',
    heading: 'Ajustes',
    back: { href: '/', label: 'Volver' },
  },
}

/**
 * `/plan/` → `/plan`, `/` → `/`.
 *
 * Workers Assets is configured `html_handling: "drop-trailing-slash"` so the slash-less
 * form is canonical (AGENTS gotcha 17); this is the same rule applied to whatever a link
 * or the address bar actually says, so one route can never be two keys in this table.
 */
export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

/** What goes in `<title>`, on the server at build time and on the client on every hop. */
export function documentTitle(path: string): string {
  const title = ROUTES[path]?.title
  return title ? `${title} · ${APP_NAME}` : APP_NAME
}
