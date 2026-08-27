import { describe, expect, it } from 'vitest'
import { formatPace } from '@/lib/activity'
import { DAY_MS, DEFAULT_BLOCK, WEEK_MS, totalWeeks } from '@/lib/block'
import { blockProgress, totals, weekMetrics } from '@/lib/metrics'
import { buildBlock, buildWeek } from '@/lib/plan'
import type { Activity, PlanWeek } from '@/lib/db/schema'

const BLOCK = DEFAULT_BLOCK
const BLOCK_START = BLOCK.startsOn
const TOTAL_WEEKS = totalWeeks(BLOCK)
let nextId = 1

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: nextId++,
    userId: 'owner',
    name: 'Run',
    sportType: 'Run',
    startedOn: BLOCK_START,
    distanceM: 10_000,
    movingS: 3_000,
    elevationGainM: 20,
    averageHeartrate: 150,
    maxHeartrate: 170,
    cadenceSpm: 170,
    sufferScore: 40,
    updatedAt: 0,
    ...overrides,
  }
}

const week = (overrides: Partial<PlanWeek> = {}): PlanWeek => ({
  userId: 'owner',
  weekIndex: 0,
  phase: null,
  focus: null,
  targetVolumeM: null,
  isDownWeek: false,
  notes: null,
  updatedAt: 0,
  ...overrides,
})

describe('totals', () => {
  it('counts running only — volume in this plan means run volume', () => {
    const result = totals([
      activity({ sportType: 'Run', distanceM: 10_000 }),
      activity({ sportType: 'Ride', distanceM: 40_000 }),
      activity({ sportType: 'WeightTraining', distanceM: 0 }),
    ])
    expect(result.runs).toBe(1)
    expect(result.distanceM).toBe(10_000)
  })

  it('takes mean pace over the whole distance, not the mean of each run’s pace', () => {
    // 5 km at 6:00/km and 15 km at 4:00/km is 4:30/km overall, not the 5:00 a naive
    // mean-of-means would report.
    const result = totals([
      activity({ distanceM: 5_000, movingS: 1_800 }),
      activity({ distanceM: 15_000, movingS: 3_600 }),
    ])
    expect(result.meanPaceSKm).toBeCloseTo(270, 5)
  })

  it('weights cadence and heart rate by time', () => {
    const result = totals([
      activity({ movingS: 3_600, cadenceSpm: 180, averageHeartrate: 160 }),
      activity({ movingS: 1_200, cadenceSpm: 160, averageHeartrate: 140 }),
    ])
    expect(result.meanCadenceSpm).toBeCloseTo((180 * 3600 + 160 * 1200) / 4800, 5)
    expect(result.meanHr).toBeCloseTo((160 * 3600 + 140 * 1200) / 4800, 5)
  })

  it('ignores runs missing a value rather than treating it as zero', () => {
    const result = totals([
      activity({ movingS: 3_600, cadenceSpm: 170 }),
      activity({ movingS: 3_600, cadenceSpm: null }),
    ])
    expect(result.meanCadenceSpm).toBe(170)
  })

  it('reports nulls, not zeroes, for a week with no runs', () => {
    const result = totals([activity({ sportType: 'Ride' })])
    expect(result).toMatchObject({ runs: 0, distanceM: 0, meanPaceSKm: null, meanCadenceSpm: null })
  })

  it('tracks the longest single run', () => {
    const result = totals([activity({ distanceM: 8_000 }), activity({ distanceM: 18_000 })])
    expect(result.longestM).toBe(18_000)
  })
})

describe('weekMetrics', () => {
  it('counts prescribed sessions, excluding rest days', () => {
    const plan = buildWeek(
      BLOCK,
      0,
      [week({ targetVolumeM: 40_000, phase: 'Base' })],
      [
        { userId: 'owner', id: 'a', scheduledOn: BLOCK_START, dayOrder: 0, type: 'easy', title: 'Easy', notes: null, steps: null, targetDistanceM: null, targetDurationS: null, targetPaceLoSKm: null, targetPaceHiSKm: null, doneAt: null, activityId: null, updatedAt: 0 },
        { userId: 'owner', id: 'r', scheduledOn: BLOCK_START + DAY_MS, dayOrder: 0, type: 'rest', title: 'Rest', notes: null, steps: null, targetDistanceM: null, targetDurationS: null, targetPaceLoSKm: null, targetPaceHiSKm: null, doneAt: null, activityId: null, updatedAt: 0 },
      ],
      [activity({ startedOn: BLOCK_START })],
    )

    const metrics = weekMetrics(plan)
    expect(metrics.sessionsPlanned).toBe(1)
    expect(metrics.sessionsDone).toBe(1)
    expect(metrics.targetVolumeM).toBe(40_000)
    expect(metrics.phase).toBe('Base')
  })

  it('includes unplanned runs in the week’s volume', () => {
    const plan = buildWeek(BLOCK, 0, [], [], [activity({ distanceM: 12_000 })])
    expect(weekMetrics(plan).totals.distanceM).toBe(12_000)
  })
})

describe('blockProgress', () => {
  const inWeek = (i: number, overrides: Partial<Activity> = {}) =>
    activity({ startedOn: BLOCK_START + i * WEEK_MS, ...overrides })

  it('compares against the weeks that have started, not the whole block', () => {
    // Otherwise every week reads as "behind" until the final one, which is not information.
    const weeks = [week({ weekIndex: 0, targetVolumeM: 20_000 }), week({ weekIndex: 1, targetVolumeM: 25_000 }), week({ weekIndex: 2, targetVolumeM: 30_000 })]
    const built = buildBlock(BLOCK, weeks, [], [inWeek(0, { distanceM: 22_000 })])
    const progress = blockProgress(BLOCK, built, BLOCK_START + 3 * DAY_MS) // mid week 0

    expect(progress.weeksElapsed).toBe(1)
    expect(progress.plannedToDateM).toBe(20_000)
    expect(progress.plannedTotalM).toBe(75_000)
    expect(progress.block.distanceM).toBe(22_000)
  })

  it('leaves the planned figures null while the plan is still empty', () => {
    const progress = blockProgress(BLOCK, buildBlock(BLOCK, [], [], []), BLOCK_START)
    expect(progress.plannedTotalM).toBeNull()
    expect(progress.plannedToDateM).toBeNull()
  })

  it('clamps elapsed weeks before the block opens and after it closes', () => {
    const empty = buildBlock(BLOCK, [], [], [])
    expect(blockProgress(BLOCK, empty, BLOCK_START - DAY_MS).weeksElapsed).toBe(0)
    expect(blockProgress(BLOCK, empty, BLOCK_START - DAY_MS).weeksRemaining).toBe(TOTAL_WEEKS)
    expect(blockProgress(BLOCK, empty, BLOCK_START + 40 * WEEK_MS).weeksElapsed).toBe(TOTAL_WEEKS)
    expect(blockProgress(BLOCK, empty, BLOCK_START + 40 * WEEK_MS).weeksRemaining).toBe(0)
  })

  it('carries the longest run of the whole block, not of one week', () => {
    const built = buildBlock(BLOCK, [], [], [inWeek(0, { distanceM: 9_000 }), inWeek(4, { distanceM: 19_000 })])
    expect(blockProgress(BLOCK, built, BLOCK_START).longestRunM).toBe(19_000)
  })
})

describe('goal pace', () => {
  const goalOf = (block: typeof BLOCK) =>
    blockProgress(block, buildBlock(block, [], [], []), block.startsOn).goalPaceSKm

  it('is carried out on the progress, so no screen re-derives it', () => {
    // 3:47/km — sub-1:20 over the half.
    expect(goalOf(BLOCK)).toBeCloseTo(227.47, 2)
    expect(formatPace(goalOf(BLOCK))).toBe('3:47')
  })

  it('is the athlete’s own target over their own distance', () => {
    // 40:00 for 10 km is 4:00/km, and nothing about the owner's half reaches into it.
    const other = { ...BLOCK, raceOn: BLOCK.startsOn + 10 * WEEK_MS, goalTimeS: 2400, raceDistanceM: 10_000 }
    expect(formatPace(goalOf(other))).toBe('4:00')
  })
})
