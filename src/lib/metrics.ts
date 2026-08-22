import { GOAL_TIME_S, HALF_MARATHON_M, TOTAL_WEEKS, weekIndex } from './block'
import { isRun, paceSKm } from './activity'
import type { WeekPlan } from './plan'
import type { Activity } from './db/schema'

/**
 * Read-time metrics. Pure, and every entry point takes `now` explicitly rather than
 * reaching for the clock — "this week" has to mean the same thing in a test as it does
 * in the app.
 *
 * Nothing here is stored. The whole block is ~150 activities, so recomputing on every
 * render costs less than the code that would keep a rollup table honest.
 */

/** Goal race pace, s/km — 3:47/km for 1:19:59 over the half. */
export const GOAL_PACE_S_KM = GOAL_TIME_S / (HALF_MARATHON_M / 1000)

interface Totals {
  runs: number
  distanceM: number
  movingS: number
  elevationM: number
  longestM: number
  /** Aggregate, not the mean of per-run paces — total distance over total time. */
  meanPaceSKm: number | null
  /** Time-weighted, so a 20-minute run does not pull the average as hard as a long one. */
  meanCadenceSpm: number | null
  meanHr: number | null
}

const EMPTY: Totals = {
  runs: 0,
  distanceM: 0,
  movingS: 0,
  elevationM: 0,
  longestM: 0,
  meanPaceSKm: null,
  meanCadenceSpm: null,
  meanHr: null,
}

/** Running totals for a set of activities. Non-runs are ignored — volume means run volume. */
export function totals(activities: Activity[]): Totals {
  const runs = activities.filter((a) => isRun(a.sportType))
  if (runs.length === 0) return EMPTY

  let distanceM = 0
  let movingS = 0
  let elevationM = 0
  let longestM = 0
  let cadenceS = 0
  let cadenceWeighted = 0
  let hrS = 0
  let hrWeighted = 0

  for (const run of runs) {
    distanceM += run.distanceM
    movingS += run.movingS
    elevationM += run.elevationGainM ?? 0
    longestM = Math.max(longestM, run.distanceM)
    if (run.cadenceSpm != null) {
      cadenceS += run.movingS
      cadenceWeighted += run.cadenceSpm * run.movingS
    }
    if (run.averageHeartrate != null) {
      hrS += run.movingS
      hrWeighted += run.averageHeartrate * run.movingS
    }
  }

  return {
    runs: runs.length,
    distanceM,
    movingS,
    elevationM,
    longestM,
    meanPaceSKm: movingS > 0 && distanceM > 0 ? paceSKm(distanceM, movingS) : null,
    meanCadenceSpm: cadenceS > 0 ? cadenceWeighted / cadenceS : null,
    meanHr: hrS > 0 ? hrWeighted / hrS : null,
  }
}

export interface WeekMetrics {
  weekIndex: number
  startsOn: number
  phase: string | null
  isDownWeek: boolean
  targetVolumeM: number | null
  totals: Totals
  sessionsPlanned: number
  sessionsDone: number
}

export function weekMetrics(plan: WeekPlan): WeekMetrics {
  const activities = [
    ...plan.sessions.flatMap((s) => (s.activity ? [s.activity] : [])),
    ...plan.extras,
  ]
  const prescribed = plan.sessions.filter((s) => s.session.type !== 'rest')

  return {
    weekIndex: plan.weekIndex,
    startsOn: plan.startsOn,
    phase: plan.week?.phase ?? null,
    isDownWeek: plan.week?.isDownWeek ?? false,
    targetVolumeM: plan.week?.targetVolumeM ?? null,
    totals: totals(activities),
    sessionsPlanned: prescribed.length,
    sessionsDone: prescribed.filter((s) => s.done).length,
  }
}

export interface BlockProgress {
  /** Current week, 0-based. Negative before the block opens. */
  weekIndex: number
  weeksElapsed: number
  weeksRemaining: number
  block: Totals
  weekly: WeekMetrics[]
  /** Sum of every week target that has been set — null while the plan is still empty. */
  plannedTotalM: number | null
  /** The share of that target covering weeks already run, for an honest on-track read. */
  plannedToDateM: number | null
  /** How the longest run so far compares with the race distance. */
  longestRunM: number
  goalPaceSKm: number
}

/**
 * The long-term view: where the block stands against what was planned for it.
 *
 * `plannedToDateM` deliberately counts only weeks that have started. Comparing cumulative
 * distance against the whole block's target would read as permanently behind until the
 * final week, which is not information.
 */
export function blockProgress(weeks: WeekPlan[], now: number): BlockProgress {
  const weekly = weeks.map(weekMetrics)
  const current = weekIndex(now)
  const weeksElapsed = Math.min(TOTAL_WEEKS, Math.max(0, current + 1))

  const withTargets = weekly.filter((w) => w.targetVolumeM != null)
  const plannedTotalM = withTargets.length
    ? withTargets.reduce((sum, w) => sum + (w.targetVolumeM ?? 0), 0)
    : null
  const toDate = withTargets.filter((w) => w.weekIndex < weeksElapsed)
  const plannedToDateM = plannedTotalM === null
    ? null
    : toDate.reduce((sum, w) => sum + (w.targetVolumeM ?? 0), 0)

  const block = totals(
    weeks.flatMap((w) => [
      ...w.sessions.flatMap((s) => (s.activity ? [s.activity] : [])),
      ...w.extras,
    ]),
  )

  return {
    weekIndex: current,
    weeksElapsed,
    weeksRemaining: Math.max(0, TOTAL_WEEKS - weeksElapsed),
    block,
    weekly,
    plannedTotalM,
    plannedToDateM,
    longestRunM: block.longestM,
    goalPaceSKm: GOAL_PACE_S_KM,
  }
}
