import { BLOCK_START, GOAL_TIME_S, RACE_DATE, RACE_DISTANCE_M, RACE_NAME } from './config'

/**
 * The training block: the window every week index, every metric and every sync counts
 * from. Activities before it are not synced.
 *
 * It is a **value**, not a set of constants, because each athlete has their own dates and
 * their own target. `block` is always the *first* argument of anything that takes one, so
 * a call site can never quietly pass the wrong athlete's window in a trailing slot — the
 * mistake that would otherwise show one runner another's plan and look plausible doing it.
 *
 * The `PUBLIC_*` build-time values in `config.ts` did not go away; they changed job. They
 * are no longer *the* block — they are `DEFAULT_BLOCK`, which is what the migration hands
 * the owner and what `/bienvenida` pre-fills a new athlete's form with. A fork still
 * points its own deployment at its own race with a `.env`, and every athlete on it can
 * still race something else.
 */
export const HALF_MARATHON_M = 21097.5

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

export interface BlockConfig {
  /** Monday 00:00, epoch ms as local wall clock. */
  startsOn: number
  raceOn: number
  goalTimeS: number
  raceDistanceM: number
  raceName: string
}

/**
 * The block this deployment ships configured for — `docs/03-training-plan-2027.md` under
 * the defaults, or whatever the fork's `.env` says.
 *
 * Two consumers and no others: the owner row created by `migrations/0004`, and the form on
 * `/bienvenida`, which offers these as a starting point rather than as an answer. No
 * component may import it: a screen that reads the default block instead of the signed-in
 * athlete's is a screen showing someone else's numbers.
 */
export const DEFAULT_BLOCK: BlockConfig = {
  startsOn: BLOCK_START,
  raceOn: RACE_DATE,
  goalTimeS: GOAL_TIME_S,
  raceDistanceM: RACE_DISTANCE_M,
  raceName: RACE_NAME,
}

/**
 * Guardrails for the onboarding form and the zod schemas. Under four weeks there is no
 * ramp to build; over forty the plan is a guess about a season, not a block.
 */
export const MIN_BLOCK_WEEKS = 4
export const MAX_BLOCK_WEEKS = 40

/** Midnight UTC of the day `at` falls on. Dates are stored as local-wall-clock epoch ms. */
export function startOfDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS
}

/** Monday of the week `at` falls in. */
export function startOfWeek(at: number): number {
  const day = startOfDay(at)
  const weekday = (new Date(day).getUTCDay() + 6) % 7 // 0 = Monday
  return day - weekday * DAY_MS
}

/**
 * Race day falls on the last day of the final week, so a block spans a whole number of
 * weeks only by rounding up — the owner's 160 days is 22 weeks and 6 days, i.e. 23 weeks.
 */
export const totalWeeks = (block: BlockConfig) =>
  Math.ceil((block.raceOn - block.startsOn) / WEEK_MS)

/** 0-based week index within the block; negative before it starts. */
export const weekIndex = (block: BlockConfig, at: number) =>
  Math.floor((startOfWeek(at) - block.startsOn) / WEEK_MS)

/** The Monday week `i` opens on — derived from the block, never stored on the week. */
export const weekStart = (block: BlockConfig, i: number) => block.startsOn + i * WEEK_MS

/** The seven days of week `i`, Monday first. */
export const weekDays = (block: BlockConfig, i: number) =>
  Array.from({ length: 7 }, (_, day) => weekStart(block, i) + day * DAY_MS)

export const daysToRace = (block: BlockConfig, at: number) =>
  Math.max(0, Math.round((block.raceOn - startOfDay(at)) / DAY_MS))

/** Target pace, s/km — the number every prescribed band is a multiple of. */
export const goalPaceSKm = (block: BlockConfig) => block.goalTimeS / (block.raceDistanceM / 1000)

/**
 * A real clock reading, moved onto the scale every date in this app lives on.
 *
 * Everything stored here is the athlete's *wall clock* pinned to UTC — `startedOn` is
 * `start_date_local` parsed as if it were UTC, `scheduledOn` is a UTC midnight, and a
 * block's `startsOn` and `raceOn` are UTC midnights. `Date.now()` is the one number in the
 * app that is not on that scale: it is the true instant. Handing it straight to
 * `startOfDay` therefore asks "which UTC day is it" when the question was "which day is it
 * here", and in Madrid those are different answers for the first one or two hours after
 * midnight — long enough for someone checking tomorrow's session at half past midnight to
 * be shown yesterday as *Hoy*, with the mint marker on the wrong column, the next session
 * pointing at a run already done, and the countdown a day out.
 *
 * Adding the zone offset back moves the instant onto the same scale as the dates it is
 * about to be compared with. Every consumer of `now` in this app is a day-scale one —
 * `startOfDay`, `startOfWeek`, `weekIndex`, `daysToRace` — so this is where the conversion
 * belongs, once, rather than at each of them. The two places that want a true instant
 * (`doneAt`, and the sync stamp on `/`) call `Date.now()` themselves and are unaffected.
 *
 * In a Worker the offset is zero and this is the identity, which is correct: nothing
 * renders a date at prerender time.
 */
export function wallClockNow(at: number = Date.now()): number {
  return at - new Date(at).getTimezoneOffset() * 60_000
}
