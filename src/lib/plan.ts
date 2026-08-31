import { startOfDay, totalWeeks, weekDays, weekIndex, weekStart, type BlockConfig } from './block'
import { formatPaceRange, isRun } from './activity'
import { PACE_ZONE_NUMBER, PACES, midOf, zoneTag, type PaceBand, type PaceZone } from './paces'
import { BY_FEEL, primaryZone, workoutBand, workoutDurationS, type Bands } from './workout'
import { PRESCRIPTION_KINDS, SESSION_TYPES, type SessionType, type SportFamily } from './session-types'
import { runSteps, type PrescriptionKind } from './prescription'
import type { Activity, PlanSession, PlanWeek } from './db/schema'

/**
 * Pure planner logic — no bindings, no I/O, no implicit `Date.now()`. Every entry point
 * takes the data it needs, which is what keeps "was this session done?" reproducible:
 * the answer is a function of the rows, not of when it was asked.
 *
 * The athlete's block is one of those things: a week index means nothing without the
 * Monday it counts from, so every entry point that needs one takes a `BlockConfig` in its
 * *first* slot — never trailing, where the wrong athlete's window could be passed quietly.
 *
 * This module is imported by the browser as well as the Worker, so it pulls in neither
 * drizzle nor zod — the session vocabulary lives here and `db/schema.ts` imports it,
 * rather than the other way round.
 */

export { SESSION_TYPES, PRESCRIPTION_KINDS, type SessionType, type SportFamily }

export interface SessionMeta {
  label: string
  family: SportFamily
  /**
   * What shape of prescription the session's `steps` column carries, or `null` for a type
   * that prescribes nothing at all. Nine types over two kinds, deliberately: the six run
   * types share one payload, and `rest` and `cross` have none to share.
   */
  prescribes: PrescriptionKind | null
  /** Whether its prescribed distance is part of the week's running volume. */
  countsAsVolume: boolean
  /** A hard day — the thing that must not land two days running. */
  isQuality: boolean
  /** Colour token; the class map lives in the UI, where Tailwind can see it. */
  accent: 'slate' | 'violet' | 'amber' | 'rose' | 'fuchsia' | 'emerald' | 'teal' | 'cyan' | 'zinc'
}

export const SESSION_META: Record<SessionType, SessionMeta> = {
  easy: { label: 'Rodaje', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: false, accent: 'slate' },
  long: { label: 'Larga', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: false, accent: 'violet' },
  tempo: { label: 'Tempo', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: true, accent: 'amber' },
  interval: { label: 'Series', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: true, accent: 'rose' },
  fartlek: { label: 'Fartlek', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: true, accent: 'fuchsia' },
  race: { label: 'Carrera', family: 'run', prescribes: 'run', countsAsVolume: true, isQuality: true, accent: 'emerald' },
  rest: { label: 'Descanso', family: 'other', prescribes: null, countsAsVolume: false, isQuality: false, accent: 'zinc' },
  cross: { label: 'Cruzado', family: 'other', prescribes: null, countsAsVolume: false, isQuality: false, accent: 'cyan' },
  strength: { label: 'Fuerza', family: 'strength', prescribes: 'strength', countsAsVolume: false, isQuality: false, accent: 'teal' },
}

/**
 * What a session asks of the legs, resolved once for every screen that says it.
 *
 * The pace is the first thing a runner needs and the easiest one to lose: it lives in
 * three places at once — the session's own `targetPace*` columns, the zone its steps
 * carry, and nowhere at all — and a card that only reads the first prints a session with
 * no target on it, which reads as missing data rather than as the deliberate silence of
 * Phase 0. So it is resolved in one place, in that order, and the absence is a value:
 * `band: null` means `A sensaciones`, which is what docs/03 §4 actually prescribes for the
 * rebuild weeks.
 *
 * `estimateS` is time on feet and never a prescription — a session measured in minutes
 * (strength, the bike) carries its own `targetDurationS` and gets no estimate here, or the
 * two would print as one number and the ≈ would be a lie.
 */
export interface SessionEffort {
  /** The band's zone, when it came from the steps. `null` for a hand-typed pace. */
  zone: PaceZone | null
  band: PaceBand | null
  /** Seconds, derived from the steps or from distance at mid-band. Always shown as ≈. */
  estimateS: number | null
}

/**
 * `bands` is the athlete's own six, from `paceBands(goalPaceSKm(block))`. It defaults to
 * the owner's table so a caller that has no block to hand — a test, the seed — reads what
 * it always did; every screen passes the signed-in athlete's, because a zone is a share of
 * *their* goal pace and Ivan's seconds mean nothing under someone else's target.
 */
export function sessionEffort(session: PlanSession, bands: Bands = PACES): SessionEffort {
  // The one reader of the column here: a tagged payload is not running steps, so the
  // effort falls back to the session's own columns — already what a duration-only
  // session does, and `runSteps` is byte-identical to this line for every array.
  const steps = runSteps(session.steps)
  // Either bound alone is still a band — the editor lets one be typed without the other.
  const lo = session.targetPaceLoSKm ?? session.targetPaceHiSKm
  const hi = session.targetPaceHiSKm ?? session.targetPaceLoSKm
  const own = lo != null && hi != null ? { lo, hi } : null
  const band = own ?? (steps ? workoutBand(steps, bands) : null)
  // The zone names the band, so it is only the steps' to give: a pace typed by hand is a
  // number, not a zone, and labelling it `Z4` would be the app inferring intent.
  const zone = own ? null : steps ? primaryZone(steps, bands) : null

  const estimateS = steps
    ? workoutDurationS(steps, bands)
    : session.targetDistanceM != null && band != null
      ? Math.round((session.targetDistanceM / 1000) * midOf(band))
      : null

  return { zone, band, estimateS }
}

/** `Z5 · 3:30–3:40/km`, and the plan's own words for a session that prescribes no band. */
export function effortLabel(effort: SessionEffort): string {
  if (!effort.band) return BY_FEEL
  const pace = formatPaceRange(effort.band.lo, effort.band.hi)
  const tag = effort.zone ? zoneTag(PACE_ZONE_NUMBER[effort.zone]) : null
  return [tag, pace].filter(Boolean).join(' · ')
}

/** The hard days. One list, so the calendar, the seed and its guardrails cannot disagree. */
export const isQuality = (type: SessionType) => SESSION_META[type].isQuality

const STRENGTH_SPORTS = new Set(['WeightTraining', 'Workout', 'Crossfit', 'Yoga', 'Pilates'])

export function sportFamily(sportType: string): SportFamily {
  if (isRun(sportType)) return 'run'
  if (STRENGTH_SPORTS.has(sportType)) return 'strength'
  return 'other'
}

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
  block: BlockConfig,
  index: number,
  weeks: PlanWeek[],
  sessions: PlanSession[],
  activities: Activity[],
): WeekPlan {
  const startsOn = weekStart(block, index)
  const sessionsByDay = groupByDay(sessions, (s) => s.scheduledOn)
  const activitiesByDay = groupByDay(activities, (a) => a.startedOn)

  const days = weekDays(block, index).map((date) =>
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

/**
 * Every week of the block, in order — the planner view.
 *
 * The week count is derived from the block rather than passed in: two arguments that have
 * to agree are one argument too many, and the one that was passed is the one that would
 * be wrong.
 */
export function buildBlock(
  block: BlockConfig,
  weeks: PlanWeek[],
  sessions: PlanSession[],
  activities: Activity[],
): WeekPlan[] {
  const sessionsByWeek = groupByWeek(block, sessions, (s) => s.scheduledOn)
  const activitiesByWeek = groupByWeek(block, activities, (a) => a.startedOn)

  return Array.from({ length: totalWeeks(block) }, (_, i) =>
    buildWeek(block, i, weeks, sessionsByWeek.get(i) ?? [], activitiesByWeek.get(i) ?? []),
  )
}

function groupByWeek<T>(
  block: BlockConfig,
  items: T[],
  dateOf: (item: T) => number,
): Map<number, T[]> {
  const byWeek = new Map<number, T[]>()
  for (const item of items) {
    const i = weekIndex(block, dateOf(item))
    const bucket = byWeek.get(i)
    if (bucket) bucket.push(item)
    else byWeek.set(i, [item])
  }
  return byWeek
}
