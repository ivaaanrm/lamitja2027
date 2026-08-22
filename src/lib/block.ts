/**
 * The training block. Everything in the app is scoped to this window — activities before
 * it are not synced, and week indices count from it.
 *
 * Source: docs/03-training-plan-2027.md.
 */
export const BLOCK_START = Date.UTC(2026, 7, 24) // Monday 24 Aug 2026
export const RACE_DATE = Date.UTC(2027, 0, 24) // Sunday 24 Jan 2027
export const RACE_NAME = 'La Mitja de Granollers'
/** Sub-1:20:00 — 1:19:59, in seconds. */
export const GOAL_TIME_S = 4799
export const HALF_MARATHON_M = 21097.5

export const WEEK_MS = 7 * 86_400_000
export const TOTAL_WEEKS = Math.round((RACE_DATE - BLOCK_START) / WEEK_MS)

/** Midnight UTC of the day `at` falls on. Dates are stored as local-wall-clock epoch ms. */
export function startOfDay(at: number): number {
  return Math.floor(at / 86_400_000) * 86_400_000
}

/** Monday of the week `at` falls in. */
export function startOfWeek(at: number): number {
  const day = startOfDay(at)
  const weekday = (new Date(day).getUTCDay() + 6) % 7 // 0 = Monday
  return day - weekday * 86_400_000
}

/** 0-based week index within the block; negative before it starts. */
export function weekIndex(at: number): number {
  return Math.floor((startOfWeek(at) - BLOCK_START) / WEEK_MS)
}

export function daysToRace(at: number): number {
  return Math.max(0, Math.round((RACE_DATE - startOfDay(at)) / 86_400_000))
}
