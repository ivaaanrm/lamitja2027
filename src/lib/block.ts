import { BLOCK_START, GOAL_TIME_S, RACE_DATE, RACE_DISTANCE_M } from './config'

/**
 * The training block. Everything in the app is scoped to this window — activities before
 * it are not synced, and week indices count from it.
 *
 * Still the app's one window; its *edges* are no longer written here. `config.ts` reads
 * them from the build's `PUBLIC_*` env, with this repository's own block — Mon 17 Aug
 * 2026 to Sun 24 Jan 2027, sub-1:20 — as the defaults, so a fork points the whole app at
 * another race by editing a `.env` rather than by editing arithmetic. They are re-exported
 * from here because this is where the rest of the app has always reached for them, and
 * because a date on its own means little without the week machinery below it.
 *
 * Source for the defaults: docs/03-training-plan-2027.md.
 */
export { BLOCK_START, GOAL_TIME_S, RACE_DATE, RACE_DISTANCE_M }

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
/**
 * Race day falls on the last day of the final week, so the block spans a whole number of
 * weeks only by rounding up — the default block's 160 days is 22 weeks and 6 days, i.e.
 * 23 weeks. `config.ts` refuses a block shorter than four.
 */
export const TOTAL_WEEKS = Math.ceil((RACE_DATE - BLOCK_START) / WEEK_MS)

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

/** 0-based week index within the block; negative before it starts. */
export function weekIndex(at: number): number {
  return Math.floor((startOfWeek(at) - BLOCK_START) / WEEK_MS)
}

export function daysToRace(at: number): number {
  return Math.max(0, Math.round((RACE_DATE - startOfDay(at)) / DAY_MS))
}

/**
 * A real clock reading, moved onto the scale every date in this app lives on.
 *
 * Everything stored here is the athlete's *wall clock* pinned to UTC — `startedOn` is
 * `start_date_local` parsed as if it were UTC, `scheduledOn` is a UTC midnight, and
 * `BLOCK_START` and `RACE_DATE` are UTC midnights out of `config.ts`. `Date.now()` is the one number
 * in the app that is not on that scale: it is the true instant. Handing it straight to
 * `startOfDay` therefore asks "which UTC day is it" when the question was "which day is it
 * here", and in Madrid those are different answers for the first one or two hours after
 * midnight — long enough for someone checking tomorrow's session at half past midnight to
 * be shown yesterday as *Hoy*, with the mint marker on the wrong column, the next session
 * pointing at a run already done, and the countdown a day out.
 *
 * Adding the zone offset back moves the instant onto the same scale as the dates it is
 * about to be compared with. Every consumer of `now` in this app is a day-scale one —
 * `startOfDay`, `startOfWeek`, `weekIndex`, `daysToRace` — so this is where the
 * conversion belongs, once, rather than at each of them. The two places that want a true
 * instant (`doneAt`, and the sync stamp on `/`) call `Date.now()` themselves and are
 * unaffected.
 *
 * In a Worker the offset is zero and this is the identity, which is correct: nothing
 * renders a date at prerender time.
 */
export function wallClockNow(at: number = Date.now()): number {
  return at - new Date(at).getTimezoneOffset() * 60_000
}
