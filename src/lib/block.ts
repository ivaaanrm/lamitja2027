/**
 * The training block. Everything in the app is scoped to this window — activities before
 * it are not synced, and week indices count from it.
 *
 * Source: docs/03-training-plan-2027.md.
 */
export const BLOCK_START = Date.UTC(2026, 7, 17) // Monday 17 Aug 2026
export const RACE_DATE = Date.UTC(2027, 0, 24) // Sunday 24 Jan 2027
/** Sub-1:20:00 — 1:19:59, in seconds. */
export const GOAL_TIME_S = 4799
export const HALF_MARATHON_M = 21097.5

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
/**
 * Race day falls on the Sunday of the final week, so the block spans a whole number of
 * weeks only by rounding up — 160 days is 22 weeks and 6 days, i.e. 23 weeks.
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
