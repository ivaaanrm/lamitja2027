import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAN_ANALYSIS_FILTERS,
  filterPlanAnalysis,
  planAnalysisRows,
  summarizePlanAnalysis,
  type PlanAnalysisFilters,
} from '../../src/lib/plan-analysis'
import type { WeekPlan } from '../../src/lib/plan'
import type { PlanSession } from '../../src/lib/db/schema'
import type { SessionType } from '../../src/lib/session-types'

const DAY = 86_400_000

function session(
  id: string,
  type: SessionType,
  day: number,
  targetDistanceM: number | null,
  dayOrder = 0,
): PlanSession {
  return {
    userId: 'athlete-1',
    id,
    scheduledOn: day,
    dayOrder,
    type,
    title: id,
    notes: null,
    steps: null,
    targetDistanceM,
    targetDurationS: null,
    targetPaceLoSKm: null,
    targetPaceHiSKm: null,
    doneAt: null,
    activityId: null,
    updatedAt: day,
  }
}

function week(weekIndex: number, phase: string | null, sessions: PlanSession[]): WeekPlan {
  const startsOn = weekIndex * 7 * DAY
  return {
    weekIndex,
    startsOn,
    week: {
      userId: 'athlete-1',
      weekIndex,
      phase,
      focus: null,
      targetVolumeM: null,
      isDownWeek: false,
      notes: null,
      updatedAt: startsOn,
    },
    days: [],
    sessions: sessions.map((item) => ({ session: item, activity: null, done: false })),
    extras: [],
  }
}

const rows = planAnalysisRows([
  week(0, 'Base', [
    session('easy', 'easy', DAY, 8_000),
    session('strength', 'strength', DAY, null, 1),
    session('rest', 'rest', 2 * DAY, null),
  ]),
  week(1, 'Calidad', [
    session('interval-short', 'interval', 8 * DAY, 10_000),
    session('long', 'long', 10 * DAY, 18_000),
    session('interval-long', 'interval', 9 * DAY, 14_000),
  ]),
])

function filters(patch: Partial<PlanAnalysisFilters> = {}): PlanAnalysisFilters {
  return { ...DEFAULT_PLAN_ANALYSIS_FILTERS, ...patch }
}

describe('plan analysis', () => {
  it('flattens prescribed work and excludes rest placeholders', () => {
    expect(rows.map((row) => row.session.id)).toEqual([
      'easy',
      'strength',
      'interval-short',
      'long',
      'interval-long',
    ])
  })

  it('filters by type and phase', () => {
    expect(filterPlanAnalysis(rows, filters({ type: 'interval' })).map((row) => row.session.id))
      .toEqual(['interval-short', 'interval-long'])
    expect(filterPlanAnalysis(rows, filters({ phase: 'Base' })).map((row) => row.session.id))
      .toEqual(['easy', 'strength'])
  })

  it('treats distance bounds as inclusive and drops distance-less sessions when bounded', () => {
    expect(
      filterPlanAnalysis(rows, filters({ minDistanceM: 10_000, maxDistanceM: 14_000 })).map(
        (row) => row.session.id,
      ),
    ).toEqual(['interval-short', 'interval-long'])

    expect(
      filterPlanAnalysis(rows, filters({ minDistanceM: 14_000 })).map((row) => row.session.id),
    ).toEqual(['interval-long', 'long'])
    expect(
      filterPlanAnalysis(rows, filters({ maxDistanceM: 10_000 })).map((row) => row.session.id),
    ).toEqual(['easy', 'interval-short'])
  })

  it('sorts by either distance direction with distance-less sessions last', () => {
    expect(
      filterPlanAnalysis(rows, filters({ sort: 'distance-desc' })).map((row) => row.session.id),
    ).toEqual(['long', 'interval-long', 'interval-short', 'easy', 'strength'])
    expect(
      filterPlanAnalysis(rows, filters({ sort: 'distance-asc' })).map((row) => row.session.id),
    ).toEqual(['easy', 'interval-short', 'interval-long', 'long', 'strength'])
  })

  it('summarizes only the visible rows', () => {
    const visible = filterPlanAnalysis(rows, filters({ type: 'interval' }))
    expect(summarizePlanAnalysis(visible)).toEqual({
      sessionCount: 2,
      distanceM: 24_000,
      weekCount: 1,
    })
  })
})
