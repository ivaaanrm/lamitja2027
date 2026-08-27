/**
 * The block this fork is training for: the race, its date and distance, when the block
 * opens, the goal time, the athlete's maximum heart rate, and the race the season before
 * it is measured against. Everything else in the app is *how* a block is tracked; this
 * file is *which* block, and it is the only file a fork has to touch to point the whole
 * app at another race.
 *
 * ## Why `import.meta.env`
 *
 * There are three ways to reach configuration in this project and only one of them works
 * here.
 *
 * `cloudflare:workers` env is a *runtime* binding. Reading it here would drag the pure
 * half of the codebase — `block.ts`, `paces.ts`, `plan.ts`, `seed.ts`, `analytics.ts`,
 * all of which import nothing from the platform and are unit-tested in plain Node —
 * into needing a Worker alive around them, and it would turn `TOTAL_WEEKS` from a
 * constant into a function call that every caller would have to thread a binding
 * through. `astro:env` is a build-time schema, but it resolves through Astro's module
 * graph, and vitest imports these modules directly with no Astro around them.
 *
 * `import.meta.env` is the only one of the three that is present in all four places
 * these numbers are read: the client bundle, the Worker, the prerender pass and the
 * unit tests. Vite substitutes it at build, so the training maths stays a set of
 * constants — `TOTAL_WEEKS` is still computable at module load, and every pure module
 * stays pure.
 *
 * What that buys is worth saying out loud: these values are *compiled in*. Changing one
 * means a rebuild and a redeploy, not a restart. That is the honest shape for values
 * that differ per **fork** rather than per environment — a race date does not change
 * between staging and production, it changes between one runner and another. Nor is any
 * of it secret: a race date and a goal time are printed on the start list. Secrets stay
 * in `.dev.vars` / `wrangler secret put`.
 *
 * The prefix is not arbitrary. Vite's default `envPrefix` is `VITE_`; Astro overrides it
 * to `PUBLIC_`, which is what exposes a var to the browser as well as the server — and
 * which is why `vitest.config.ts` needs the same `envPrefix: 'PUBLIC_'` line for a
 * fork's `.env` to reach the unit tests and not just the build.
 *
 * ## Strings, empties and loud failure
 *
 * `import.meta.env` hands back a string or `undefined`. An empty string is neither:
 * `PUBLIC_HR_MAX=` is a line somebody meant to fill in and did not, so every helper
 * treats blank as absent and falls back to the default rather than parsing `''` into
 * `0` or `NaN`. And every value is validated here, at module load, so a typo throws
 * during the build instead of quietly seeding twenty-three weeks of plan against the
 * wrong year. These messages are English, unlike everything a person reads in the app:
 * they are read in a build log by whoever just edited `.env`, not by the athlete.
 *
 * Reads are written out as `import.meta.env.PUBLIC_*` at each call site rather than
 * destructured, because that exact text is what Vite substitutes.
 */

// `block.ts` publishes WEEK_MS, but it imports *this* file, so the one constant the
// validations below need is re-derived here rather than imported back.
const WEEK_MS = 7 * 86_400_000

/**
 * This repository's own block, as the strings a `.env` would carry.
 *
 * They are the defaults in the literal sense — with no `.env` at all the app produces
 * exactly the numbers, dates and paces it produced before any of this was configurable —
 * and they are exported so a test can assert that without going near `import.meta.env`.
 */
export const DEFAULTS = {
  appName: 'La Mitja 2027',
  appShortName: 'La Mitja',
  appDescription:
    'Entrenamiento hacia una media maratón por debajo de 1:20 en La Mitja, el 24 de enero de 2027.',
  raceName: 'La Mitja de Granollers',
  raceDate: '2027-01-24',
  raceDistanceM: 21_097.5,
  blockStart: '2026-08-17',
  goalTime: '1:19:59',
  hrMax: 192,
  prevRaceDate: '2026-01-18',
} as const

/** Blank is absent: an unfilled `.env` line is not an answer. */
const supplied = (raw: string | undefined, fallback: string): string => {
  const value = raw?.trim()
  return value ? value : fallback
}

/** A free-text value — the race's name, as it is printed on the bib. */
export function text(name: string, raw: string | undefined, fallback: string): string {
  const value = supplied(raw, fallback)
  if (!value) throw new Error(`${name} is empty. Give it a value or delete the line.`)
  return value
}

/**
 * A positive quantity: a distance, a heart rate. Everything numeric this file reads is
 * a measurement of something, and none of them can be zero or negative, so the
 * positivity check lives in the helper rather than being repeated at each call.
 */
export function number(name: string, raw: string | undefined, fallback: number): number {
  const value = supplied(raw, String(fallback))
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, not "${value}".`)
  if (parsed <= 0) throw new Error(`${name} must be greater than zero, not ${parsed}.`)
  return parsed
}

/**
 * A calendar day as `YYYY-MM-DD`, read as UTC midnight — the scale every date in this
 * app lives on (see `block.ts`: stored dates are the athlete's wall clock pinned to UTC).
 *
 * The round-trip through `Date` is what rejects `2027-02-30` and `2026-13-01`, which
 * `Date.UTC` would otherwise roll over into a real day in the wrong month without
 * complaining.
 */
export function isoDate(name: string, raw: string | undefined, fallback: string): number {
  const value = supplied(raw, fallback)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`${name} must be a date as YYYY-MM-DD, not "${value}".`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const at = Date.UTC(year, month - 1, day)
  const back = new Date(at)
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new Error(`${name}: "${value}" is not a real calendar day.`)
  }
  return at
}

/**
 * A duration written the way a finish time is written — `h:mm:ss`, or `mm:ss` for
 * anything under an hour — returned in seconds.
 *
 * The leading field is unbounded (`95:00` is a legitimate way to write a 1:35 goal);
 * the fields after it are clock fields and cannot reach 60.
 */
export function clock(name: string, raw: string | undefined, fallback: string): number {
  const value = supplied(raw, fallback)
  const parts = value.split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`${name} must be a time as h:mm:ss or mm:ss, not "${value}".`)
  }
  const fields = parts.map(Number)
  const seconds = fields[fields.length - 1]!
  const minutes = fields[fields.length - 2]!
  const hours = fields.length === 3 ? fields[0]! : 0
  if (seconds > 59 || (fields.length === 3 && minutes > 59)) {
    throw new Error(`${name}: "${value}" has a clock field over 59 — it reads as h:mm:ss or mm:ss.`)
  }
  const total = hours * 3600 + minutes * 60 + seconds
  if (total <= 0) throw new Error(`${name} must be longer than zero, not "${value}".`)
  return total
}

/**
 * The rules that no single value can check on its own.
 *
 * Exported, and taking its three dates as arguments, because a validation nobody can
 * call is a validation nobody can test — and these are the ones that turn a plausible
 * `.env` into a plan for the wrong year.
 */
export function checkBlock(dates: {
  blockStart: number
  raceDate: number
  prevRaceDate: number
}): void {
  const { blockStart, raceDate, prevRaceDate } = dates

  // Week indices count from the block's Monday, and every week in the plan is
  // `BLOCK_START + i * WEEK_MS`. Opening the block on a Tuesday would put every week
  // boundary mid-week and every long run on the wrong side of one.
  if (new Date(blockStart).getUTCDay() !== 1) {
    throw new Error(
      `PUBLIC_BLOCK_START must be a Monday — the block counts weeks from it. ` +
        `${new Date(blockStart).toISOString().slice(0, 10)} is a ` +
        `${new Date(blockStart).toUTCString().slice(0, 3)}.`,
    )
  }
  if (raceDate <= blockStart) {
    throw new Error(
      `PUBLIC_RACE_DATE must fall after PUBLIC_BLOCK_START, and ` +
        `${new Date(raceDate).toISOString().slice(0, 10)} does not.`,
    )
  }
  // Four weeks is not a training block, but it is the shortest window in which the
  // week-by-week machinery — phases, a ramp, a down week — means anything at all.
  const weeks = Math.ceil((raceDate - blockStart) / WEEK_MS)
  if (weeks < 4) {
    throw new Error(
      `The block is ${weeks} week(s) long. PUBLIC_RACE_DATE must be at least four weeks ` +
        `after PUBLIC_BLOCK_START.`,
    )
  }
  // The baseline season is laid over this block by shifting it forward, so a previous
  // race that has not happened yet would shift backwards and land nowhere.
  if (prevRaceDate >= raceDate) {
    throw new Error(
      `PUBLIC_PREV_RACE_DATE must fall before PUBLIC_RACE_DATE — it is last season's ` +
        `race, the one this block is measured against.`,
    )
  }
}

/**
 * What the app calls itself, and the four values below it are the whole of its identity.
 *
 * They are separate from `RACE_NAME` on purpose: the event is *La Mitja de Granollers* and
 * the app is *La Mitja 2027*, which is a different noun — one is printed on a bib and the
 * other is printed on a home screen. A fork that only overrode the race would end up with
 * a tab reading `Plan · La Mitja 2027` above a plan for the Berlin marathon.
 *
 * These reach every user-visible name in one hop: the `<title>` of all eight pages, the
 * launch-screen wordmark, the login screen, `404`, the meta description, the Open Graph
 * card, and `manifest.webmanifest` — which is generated from these rather than served as a
 * static file, because a JSON file in `public/` cannot read a build-time value.
 *
 * What they deliberately do *not* reach is the Spanish prose the app is written in, the
 * plan in `seed.ts`, or the icons — a name is one string, and those are not. `docs/setup.md`
 * says so plainly rather than letting a forker discover it.
 */
export const APP_NAME = text('PUBLIC_APP_NAME', import.meta.env.PUBLIC_APP_NAME, DEFAULTS.appName)

/**
 * The home-screen label, which is the one place a name is truncated by somebody else.
 * iOS gives it about twelve characters before it ellipsises, so this is the short form —
 * *La Mitja*, not *La Mitja 2027*.
 */
export const APP_SHORT_NAME = text(
  'PUBLIC_APP_SHORT_NAME',
  import.meta.env.PUBLIC_APP_SHORT_NAME,
  DEFAULTS.appShortName,
)

/** One sentence, and it is read three times: the meta description, the Open Graph card
 * and the manifest. It used to be two near-identical sentences that could drift apart. */
export const APP_DESCRIPTION = text(
  'PUBLIC_APP_DESCRIPTION',
  import.meta.env.PUBLIC_APP_DESCRIPTION,
  DEFAULTS.appDescription,
)

/** The race, as it is printed on the bib. Ends up as the title of the final session. */
export const RACE_NAME = text(
  'PUBLIC_RACE_NAME',
  import.meta.env.PUBLIC_RACE_NAME,
  DEFAULTS.raceName,
)

/** Race day. The block ends on it, and every countdown in the app points at it. */
export const RACE_DATE = isoDate(
  'PUBLIC_RACE_DATE',
  import.meta.env.PUBLIC_RACE_DATE,
  DEFAULTS.raceDate,
)

/** The race distance in metres, Strava units. 21 097,5 m is the half marathon. */
export const RACE_DISTANCE_M = number(
  'PUBLIC_RACE_DISTANCE_M',
  import.meta.env.PUBLIC_RACE_DISTANCE_M,
  DEFAULTS.raceDistanceM,
)

/** The Monday the block opens on. Nothing before it is synced or counted. */
export const BLOCK_START = isoDate(
  'PUBLIC_BLOCK_START',
  import.meta.env.PUBLIC_BLOCK_START,
  DEFAULTS.blockStart,
)

/** The goal, in seconds. Every pace band in `paces.ts` is a ratio of the pace it implies. */
export const GOAL_TIME_S = clock(
  'PUBLIC_GOAL_TIME',
  import.meta.env.PUBLIC_GOAL_TIME,
  DEFAULTS.goalTime,
)

/**
 * Maximum heart rate. The five zone floors in `paces.ts` are shares of it, and the app
 * never renders a bpm — only the zone one falls in.
 */
export const HR_MAX = number('PUBLIC_HR_MAX', import.meta.env.PUBLIC_HR_MAX, DEFAULTS.hrMax)

/**
 * Last season's race — the anchor the previous build is aligned on, so its rows can be
 * laid over this block at the same distance from race day. See `baseline.ts`.
 */
export const PREV_RACE_DATE = isoDate(
  'PUBLIC_PREV_RACE_DATE',
  import.meta.env.PUBLIC_PREV_RACE_DATE,
  DEFAULTS.prevRaceDate,
)

checkBlock({ blockStart: BLOCK_START, raceDate: RACE_DATE, prevRaceDate: PREV_RACE_DATE })
