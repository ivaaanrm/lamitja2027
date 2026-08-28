import type { PlanSession } from './db/schema'
import type { WeekPlan } from './plan'
import type { SessionType } from './session-types'

/** One prescribed session with the block context its database row deliberately omits. */
export interface PlanAnalysisRow {
  session: PlanSession
  /** Zero-based, like every week index inside the app. */
  weekIndex: number
  phase: string | null
}

export type PlanAnalysisSort = 'plan' | 'distance-desc' | 'distance-asc'

export interface PlanAnalysisFilters {
  /** `null` means every session type. */
  type: SessionType | null
  /** `null` means every phase, including sessions whose week has no phase. */
  phase: string | null
  minDistanceM: number | null
  maxDistanceM: number | null
  sort: PlanAnalysisSort
}

export const DEFAULT_PLAN_ANALYSIS_FILTERS: PlanAnalysisFilters = {
  type: null,
  phase: null,
  minDistanceM: null,
  maxDistanceM: null,
  sort: 'plan',
}

export interface PlanAnalysisSummary {
  sessionCount: number
  distanceM: number
  weekCount: number
}

/**
 * Flattens the plan into analysis rows. Rest is a calendar placeholder, not prescribed
 * work: counting it as a session would make both “how many sessions?” and average weekly
 * frequency depend on how explicitly somebody wrote their days off.
 */
export function planAnalysisRows(weeks: WeekPlan[]): PlanAnalysisRow[] {
  return weeks.flatMap((week) =>
    week.sessions.flatMap(({ session }) =>
      session.type === 'rest'
        ? []
        : [{ session, weekIndex: week.weekIndex, phase: week.week?.phase ?? null }],
    ),
  )
}

function comparePlanOrder(a: PlanAnalysisRow, b: PlanAnalysisRow): number {
  return (
    a.weekIndex - b.weekIndex ||
    a.session.scheduledOn - b.session.scheduledOn ||
    a.session.dayOrder - b.session.dayOrder ||
    a.session.id.localeCompare(b.session.id)
  )
}

function distanceForSort(row: PlanAnalysisRow, direction: 'asc' | 'desc'): number {
  // Distance-less strength and cross sessions belong in an unbounded result, but always
  // after sessions with a comparable number whichever direction the athlete selected.
  if (row.session.targetDistanceM == null)
    return direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  return row.session.targetDistanceM
}

/** Applies all filters and returns a new, deterministically ordered array. */
export function filterPlanAnalysis(
  rows: PlanAnalysisRow[],
  filters: PlanAnalysisFilters,
): PlanAnalysisRow[] {
  const hasDistanceBound = filters.minDistanceM != null || filters.maxDistanceM != null
  const filtered = rows.filter((row) => {
    const { session } = row
    if (filters.type != null && session.type !== filters.type) return false
    if (filters.phase != null && row.phase !== filters.phase) return false

    if (hasDistanceBound) {
      if (session.targetDistanceM == null) return false
      if (filters.minDistanceM != null && session.targetDistanceM < filters.minDistanceM)
        return false
      if (filters.maxDistanceM != null && session.targetDistanceM > filters.maxDistanceM)
        return false
    }
    return true
  })

  return filtered.sort((a, b) => {
    if (filters.sort === 'distance-desc')
      return distanceForSort(b, 'desc') - distanceForSort(a, 'desc') || comparePlanOrder(a, b)
    if (filters.sort === 'distance-asc')
      return distanceForSort(a, 'asc') - distanceForSort(b, 'asc') || comparePlanOrder(a, b)
    return comparePlanOrder(a, b)
  })
}

/** The three answers above the table, always calculated from the visible result. */
export function summarizePlanAnalysis(rows: PlanAnalysisRow[]): PlanAnalysisSummary {
  const weeks = new Set<number>()
  let distanceM = 0

  for (const row of rows) {
    weeks.add(row.weekIndex)
    distanceM += row.session.targetDistanceM ?? 0
  }

  return { sessionCount: rows.length, distanceM, weekCount: weeks.size }
}

