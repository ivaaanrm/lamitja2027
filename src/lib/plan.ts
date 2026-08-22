import { BLOCK_START, DAY_MS, WEEK_MS, startOfDay, weekIndex } from './block'
import { isRun } from './activity'
import type { Activity, PlanSession, PlanWeek } from './db/schema'

/**
 * Pure planner logic — no bindings, no I/O, no implicit `Date.now()`. Every entry point
 * takes the data it needs, which is what keeps "was this session done?" reproducible:
 * the answer is a function of the rows, not of when it was asked.
 *
 * This module is imported by the browser as well as the Worker, so it pulls in neither
 * drizzle nor zod — the session vocabulary lives here and `db/schema.ts` imports it,
 * rather than the other way round.
 */

export const SESSION_TYPES = [
  'easy',
  'long',
  'tempo',
  'interval',
  'race',
  'rest',
  'cross',
  'strength',
] as const
export type SessionType = (typeof SESSION_TYPES)[number]

/** What a session type is measured in, and which activities can satisfy it. */
type SportFamily = 'run' | 'strength' | 'other'

export const SESSION_META: Record<
  SessionType,
  { label: string; family: SportFamily; countsAsVolume: boolean }
> = {
  easy: { label: 'Easy', family: 'run', countsAsVolume: true },
  long: { label: 'Long', family: 'run', countsAsVolume: true },
  tempo: { label: 'Tempo', family: 'run', countsAsVolume: true },
  interval: { label: 'Intervals', family: 'run', countsAsVolume: true },
  race: { label: 'Race', family: 'run', countsAsVolume: true },
  rest: { label: 'Rest', family: 'other', countsAsVolume: false },
  cross: { label: 'Cross', family: 'other', countsAsVolume: false },
  strength: { label: 'Strength', family: 'strength', countsAsVolume: false },
}

const STRENGTH_SPORTS = new Set(['WeightTraining', 'Workout', 'Crossfit', 'Yoga', 'Pilates'])

function sportFamily(sportType: string): SportFamily {
  if (isRun(sportType)) return 'run'
  if (STRENGTH_SPORTS.has(sportType)) return 'strength'
  return 'other'
}

/** Monday 00:00 of week `i`, epoch ms. The inverse of `weekIndex`. */
export const weekStart = (i: number) => BLOCK_START + i * WEEK_MS

/** The seven local midnights of week `i`, Monday first. */
export const weekDays = (i: number) =>
  Array.from({ length: 7 }, (_, day) => weekStart(i) + day * DAY_MS)

/** A session paired with whatever actually happened, if anything. */
export interface MatchedSession {
  session: PlanSession
  activity: Activity | null
  /** Ticked off by hand, or satisfied by a matched activity. */
  done: boolean
}

export interface DayPlan {
  date: number
  sessions: MatchedSession[]
  /** Activities on this day that satisfied no prescribed session. */
  extras: Activity[]
}

export interface WeekPlan {
  weekIndex: number
  startsOn: number
  week: PlanWeek | null
  days: DayPlan[]
  sessions: MatchedSession[]
  extras: Activity[]
}

/**
 * Pairs each session with the activity that satisfied it, one day at a time.
 *
 * Matching is done on read rather than written back on sync: a corrected distance or a
 * session moved to another day re-resolves on the next render, and completing a run needs
 * no database write at all. A hand-set `activityId` always wins, which is the escape hatch
 * for the days the heuristic gets wrong.
 */
export function matchDay(date: number, sessions: PlanSession[], activities: Activity[]): DayPlan {
  const ordered = [...sessions].sort((a, b) => a.dayOrder - b.dayOrder)
  const pool = new Map(activities.map((a) => [a.id, a]))
  const matched = new Map<string, Activity>()

  // Pass 1: explicit pins, so a manual link is never stolen by the heuristic.
  for (const session of ordered) {
    const pinned = session.activityId == null ? undefined : pool.get(session.activityId)
    if (pinned) {
      matched.set(session.id, pinned)
      pool.delete(pinned.id)
    }
  }

  // Pass 2: each remaining session takes the closest unclaimed activity of its family.
  for (const session of ordered) {
    if (matched.has(session.id)) continue
    const meta = SESSION_META[session.type]
    if (session.type === 'rest') continue

    let best: Activity | null = null
    let bestCost = Infinity
    for (const activity of pool.values()) {
      if (sportFamily(activity.sportType) !== meta.family) continue
      // With a target, the nearest distance wins; without one, the longest effort does.
      const cost =
        session.targetDistanceM == null
          ? -activity.distanceM
          : Math.abs(activity.distanceM - session.targetDistanceM)
      if (cost < bestCost) {
        best = activity
        bestCost = cost
      }
    }

    if (best) {
      matched.set(session.id, best)
      pool.delete(best.id)
    }
  }

  return {
    date,
    sessions: ordered.map((session) => {
      const activity = matched.get(session.id) ?? null
      return { session, activity, done: session.doneAt != null || activity != null }
    }),
    extras: [...pool.values()].sort((a, b) => a.startedOn - b.startedOn),
  }
}

function groupByDay<T>(items: T[], dateOf: (item: T) => number): Map<number, T[]> {
  const byDay = new Map<number, T[]>()
  for (const item of items) {
    const day = startOfDay(dateOf(item))
    const bucket = byDay.get(day)
    if (bucket) bucket.push(item)
    else byDay.set(day, [item])
  }
  return byDay
}

/** The full picture for one week: prescribed, done, and done-but-unprescribed. */
export function buildWeek(
  index: number,
  weeks: PlanWeek[],
  sessions: PlanSession[],
  activities: Activity[],
): WeekPlan {
  const startsOn = weekStart(index)
  const sessionsByDay = groupByDay(sessions, (s) => s.scheduledOn)
  const activitiesByDay = groupByDay(activities, (a) => a.startedOn)

  const days = weekDays(index).map((date) =>
    matchDay(date, sessionsByDay.get(date) ?? [], activitiesByDay.get(date) ?? []),
  )

  return {
    weekIndex: index,
    startsOn,
    week: weeks.find((w) => w.weekIndex === index) ?? null,
    days,
    sessions: days.flatMap((d) => d.sessions),
    extras: days.flatMap((d) => d.extras),
  }
}

/** Every week of the block, in order — the planner view. */
export function buildBlock(
  totalWeeks: number,
  weeks: PlanWeek[],
  sessions: PlanSession[],
  activities: Activity[],
): WeekPlan[] {
  const sessionsByWeek = groupByWeek(sessions, (s) => s.scheduledOn)
  const activitiesByWeek = groupByWeek(activities, (a) => a.startedOn)

  return Array.from({ length: totalWeeks }, (_, i) =>
    buildWeek(i, weeks, sessionsByWeek.get(i) ?? [], activitiesByWeek.get(i) ?? []),
  )
}

function groupByWeek<T>(items: T[], dateOf: (item: T) => number): Map<number, T[]> {
  const byWeek = new Map<number, T[]>()
  for (const item of items) {
    const i = weekIndex(dateOf(item))
    const bucket = byWeek.get(i)
    if (bucket) bucket.push(item)
    else byWeek.set(i, [item])
  }
  return byWeek
}
