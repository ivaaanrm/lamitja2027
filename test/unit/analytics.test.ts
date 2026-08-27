import { describe, expect, it } from 'vitest'
import { formatClock } from '@/lib/activity'
import {
  type BlockConfig,
  DAY_MS,
  HALF_MARATHON_M,
  DEFAULT_BLOCK,
  WEEK_MS,
  totalWeeks,
} from '@/lib/block'
import { DEFAULT_HR_MAX } from '@/lib/paces'
import {
  activityLoad,
  bestEfforts,
  consistency,
  cumulativeByDay,
  days,
  isEffortRun,
  estimatedShare,
  fitnessSeries,
  formLabel,
  percentDelta,
  projectHalf,
  riegel,
  summarise,
  weeklyTotals,
  zoneCoverage,
  zoneShares,
} from '@/lib/analytics'
import type { Activity } from '@/lib/db/schema'

const BLOCK = DEFAULT_BLOCK
const BLOCK_START = BLOCK.startsOn
const TOTAL_WEEKS = totalWeeks(BLOCK)
/** The owner has no `hr_max` of his own, so the zones are read off the fallback. */
const HR_MAX = DEFAULT_HR_MAX
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

const day = (n: number) => BLOCK_START + n * DAY_MS

describe('training load', () => {
  it('reads Strava’s Relative Effort when it is there', () => {
    expect(activityLoad(activity({ sufferScore: 63 }))).toBe(63)
  })

  it('falls back to pace and duration only when the strap was off', () => {
    const easy = activity({ sufferScore: null, distanceM: 10_000, movingS: 3_150 })
    const hard = activity({ sufferScore: null, distanceM: 10_000, movingS: 2_400 })
    expect(activityLoad(easy)).toBeGreaterThan(0)
    // A 40-minute 10K is far more than a 52-minute one, and the model has to say so.
    expect(activityLoad(hard)).toBeGreaterThan(activityLoad(easy) * 2)
  })

  it('costs a ride by its duration — there is no pace to read it by', () => {
    const ride = activity({ sportType: 'Ride', sufferScore: null, distanceM: 30_000, movingS: 3_600 })
    expect(activityLoad(ride)).toBeCloseTo(0.96 * 60, 5)
  })

  it('reports how much of a window was guessed', () => {
    expect(estimatedShare([activity({ sufferScore: 40 })])).toBe(0)
    expect(estimatedShare([activity({ sufferScore: null })])).toBe(1)
    expect(estimatedShare([])).toBe(0)
  })
})

describe('fitness', () => {
  it('rises with load and decays without it', () => {
    const runs = Array.from({ length: 14 }, (_, i) =>
      activity({ startedOn: day(i), sufferScore: 50 }),
    )
    const series = fitnessSeries(runs, BLOCK_START, day(41))
    const peak = series[13]!
    const later = series.at(-1)!

    expect(peak.fitness).toBeGreaterThan(series[0]!.fitness)
    expect(later.fitness).toBeLessThan(peak.fitness)
  })

  it('lets fatigue answer faster than fitness', () => {
    const runs = Array.from({ length: 7 }, (_, i) => activity({ startedOn: day(i), sufferScore: 80 }))
    const series = fitnessSeries(runs, BLOCK_START, day(6))
    expect(series.at(-1)!.fatigue).toBeGreaterThan(series.at(-1)!.fitness)
  })

  it('runs in from history outside the window, so the block does not open at zero', () => {
    const history = Array.from({ length: 42 }, (_, i) =>
      activity({ startedOn: BLOCK_START - (42 - i) * DAY_MS, sufferScore: 50 }),
    )
    const cold = fitnessSeries([activity({ startedOn: BLOCK_START })], BLOCK_START, BLOCK_START)
    const warm = fitnessSeries(
      [...history, activity({ startedOn: BLOCK_START })],
      BLOCK_START,
      BLOCK_START,
    )
    expect(warm[0]!.fitness).toBeGreaterThan(cold[0]!.fitness * 5)
  })

  it('reads form from yesterday — today has not been run yet', () => {
    const series = fitnessSeries([activity({ startedOn: BLOCK_START, sufferScore: 200 })], BLOCK_START, BLOCK_START)
    expect(series[0]!.form).toBe(0)
  })

  it('names the bands the way a runner would', () => {
    expect(formLabel(-40).label).toBe('Sobrecarga')
    expect(formLabel(-20).label).toBe('Construyendo')
    expect(formLabel(0).label).toBe('Estable')
    expect(formLabel(15).label).toBe('Fresco')
    expect(formLabel(40).label).toBe('Desentrenando')
  })
})

describe('series', () => {
  it('gives one point per day, inclusive of both ends', () => {
    expect(days(BLOCK_START, day(6))).toHaveLength(7)
    expect(days(BLOCK_START, BLOCK_START)).toHaveLength(1)
  })

  it('accumulates distance and holds it flat on rest days', () => {
    const series = cumulativeByDay(
      [activity({ startedOn: day(0), distanceM: 5_000 }), activity({ startedOn: day(2), distanceM: 7_000 })],
      BLOCK_START,
      day(3),
    )
    expect(series).toEqual([5_000, 5_000, 12_000, 12_000])
  })

  it('stays null before the first run, so a later season starts later', () => {
    const series = cumulativeByDay([activity({ startedOn: day(2), distanceM: 5_000 })], BLOCK_START, day(3))
    expect(series).toEqual([null, null, 5_000, 5_000])
  })

  it('counts running only', () => {
    const series = cumulativeByDay(
      [activity({ startedOn: day(0), sportType: 'Ride', distanceM: 40_000 })],
      BLOCK_START,
      day(0),
    )
    expect(series).toEqual([null])
  })
})

describe('weekly totals', () => {
  it('is null outside the weeks the data reaches, and zero inside them', () => {
    const weeks = weeklyTotals(
      BLOCK,
      [
        activity({ startedOn: BLOCK_START + 1 * WEEK_MS, distanceM: 30_000 }),
        activity({ startedOn: BLOCK_START + 3 * WEEK_MS, distanceM: 40_000 }),
      ],
      TOTAL_WEEKS,
    )
    expect(weeks[0]).toBeNull()
    expect(weeks[1]!.distanceM).toBe(30_000)
    // A week off inside the season is a fact; a week before it started is not.
    expect(weeks[2]!.distanceM).toBe(0)
    expect(weeks[3]!.distanceM).toBe(40_000)
    expect(weeks[4]).toBeNull()
  })

  it('is all null for a season with nothing in it', () => {
    expect(weeklyTotals(BLOCK, [], TOTAL_WEEKS).every((w) => w === null)).toBe(true)
  })
})

describe('best efforts', () => {
  const runs = [
    activity({ distanceM: 5_200, movingS: 1_200 }), // 3:51/km over 5.2 km
    activity({ distanceM: 12_000, movingS: 3_000 }), // 4:10/km over 12 km
    activity({ distanceM: 8_000, movingS: 2_400 }), // 5:00/km — long enough for 5K only
  ]

  it('takes the fastest run long enough to count', () => {
    const [five, ten, fifteen, half] = bestEfforts(BLOCK, runs, HR_MAX)
    expect(five!.paceSKm).toBeCloseTo(1_200 / 5.2, 5)
    // Nothing shorter can claim the 10K: only the 12 km run is long enough.
    expect(ten!.paceSKm).toBeCloseTo(3_000 / 12, 5)
    expect(fifteen!.paceSKm).toBeNull()
    expect(half!.activity).toBeNull()
  })

  it('reports the time the benchmark itself would take at that pace', () => {
    const ten = bestEfforts(BLOCK, runs, HR_MAX)[1]!
    expect(ten.timeS).toBeCloseTo((3_000 / 12) * 10, 5)
  })

  it('ignores anything that is not a run', () => {
    const ride = activity({ sportType: 'Ride', distanceM: 40_000, movingS: 4_000 })
    expect(bestEfforts(BLOCK, [ride], HR_MAX).every((b) => b.activity === null)).toBe(true)
  })

  it('will not let a long easy run claim a best', () => {
    // 10 km at 5:24/km with the heart rate in Z2 — a rodaje, not a 10K.
    const easy = activity({ distanceM: 10_000, movingS: 3_240, averageHeartrate: 140 })
    expect(isEffortRun(BLOCK, easy, HR_MAX)).toBe(false)
    expect(bestEfforts(BLOCK, [easy], HR_MAX).every((b) => b.activity === null)).toBe(true)
  })

  it('counts a hard run the strap saw, even at a modest pace', () => {
    // 4:44/km is slower than steady, but 181 bpm is Z5 — an all-out effort on tired legs.
    expect(
      isEffortRun(BLOCK, activity({ distanceM: 8_160, movingS: 2_316, averageHeartrate: 181 }), HR_MAX),
    ).toBe(true)
  })

  it('counts a fast run from a season with no strap at all', () => {
    expect(
      isEffortRun(BLOCK, activity({ distanceM: 10_033, movingS: 2_382, averageHeartrate: null }), HR_MAX),
    ).toBe(true)
  })

  it('measures the effort against the athlete’s own bands, not the owner’s', () => {
    // 5:20/km is a rodaje for a sub-1:20 runner and a hard tempo for someone chasing
    // 1:45. Held against the owner's 4:35 steady bound the second athlete would never
    // record a best at all, and their projection would read as empty rather than as slow.
    const modest: BlockConfig = { ...BLOCK, goalTimeS: 6300, raceName: 'Media' } // 1:45
    const run = activity({ distanceM: 10_000, movingS: 3_200, averageHeartrate: null })

    expect(isEffortRun(BLOCK, run, HR_MAX)).toBe(false)
    expect(isEffortRun(modest, run, HR_MAX)).toBe(true)
  })

  it('reads Z4 off the athlete’s own maximum', () => {
    // 168 bpm is Z4 against a 192 max and only Z3 against a 205 one — the same run, and
    // the strap is the only thing that changed hands.
    const run = activity({ distanceM: 10_000, movingS: 3_240, averageHeartrate: 168 })
    expect(isEffortRun(BLOCK, run, 192)).toBe(true)
    expect(isEffortRun(BLOCK, run, 205)).toBe(false)
  })
})

describe('projection', () => {
  it('scales up by Riegel’s exponent, not linearly', () => {
    const half = riegel(2_400, 10_000, 21_097.5)
    expect(half).toBeGreaterThan(2_400 * 2.1)
    expect(formatClock(half)).toBe('1:28:15')
  })

  it('takes the strongest benchmark and says which one it was', () => {
    const projection = projectHalf(
      bestEfforts(
        BLOCK,
        [
          activity({ distanceM: 10_000, movingS: 2_260 }), // a sharp 10K
          activity({ distanceM: 16_000, movingS: 4_800 }), // a steady long run
        ],
        HR_MAX,
      ),
      HALF_MARATHON_M,
    )
    expect(projection!.from.label).toBe('10K')
  })

  it('projects onto the race the athlete actually entered', () => {
    // The same 10K says one thing about a half and quite another about a 10K — where it
    // *is* the benchmark, Riegel has nothing to extrapolate and the time comes through.
    const efforts = bestEfforts(BLOCK, [activity({ distanceM: 10_000, movingS: 2_260 })], HR_MAX)
    expect(formatClock(projectHalf(efforts, 10_000)!.timeS)).toBe('37:40')
    expect(projectHalf(efforts, HALF_MARATHON_M)!.timeS).toBeGreaterThan(2_260 * 2.1)
  })

  it('is null when nothing has been run far enough', () => {
    const efforts = bestEfforts(BLOCK, [activity({ distanceM: 3_000, movingS: 900 })], HR_MAX)
    expect(projectHalf(efforts, HALF_MARATHON_M)).toBeNull()
  })
})

describe('consistency', () => {
  it('measures the gaps, not the totals', () => {
    // Runs on days 0 and 10: a nine-day hole in between.
    const result = consistency(
      [activity({ startedOn: day(0) }), activity({ startedOn: day(10) })],
      BLOCK_START,
      day(10),
    )
    expect(result.days).toBe(11)
    expect(result.runs).toBe(2)
    expect(result.longestGapDays).toBe(9)
    expect(result.breaks).toBe(1)
  })

  it('counts a break that is still open — that is the one that matters', () => {
    const result = consistency([activity({ startedOn: day(0) })], BLOCK_START, day(8))
    expect(result.longestGapDays).toBe(8)
    expect(result.breaks).toBe(1)
  })

  it('does not let cross-training close a running gap', () => {
    const result = consistency(
      [
        activity({ startedOn: day(0) }),
        activity({ startedOn: day(4), sportType: 'Ride' }),
        activity({ startedOn: day(8) }),
      ],
      BLOCK_START,
      day(8),
    )
    expect(result.longestGapDays).toBe(7)
    expect(result.breaks).toBe(1)
  })

  it('counts two runs in a day as one day run', () => {
    const result = consistency(
      [activity({ startedOn: day(0) }), activity({ startedOn: day(0) })],
      BLOCK_START,
      day(0),
    )
    expect(result.runs).toBe(2)
    expect(result.daysRun).toBe(1)
    expect(result.rate).toBe(1)
  })
})

describe('summarise', () => {
  const window = [
    activity({ startedOn: day(0), distanceM: 10_000, movingS: 3_000 }),
    activity({ startedOn: day(3), distanceM: 12_000, movingS: 3_600 }),
  ]

  it('holds a whole window to its own dates', () => {
    const outside = activity({ startedOn: day(20), distanceM: 50_000 })
    const summary = summarise([...window, outside], BLOCK_START, day(6))
    expect(summary.totals.distanceM).toBe(22_000)
    expect(summary.weeks).toBe(1)
    expect(summary.distancePerWeekM).toBe(22_000)
  })

  it('takes fitness from the run-in as well as the window', () => {
    const runIn = Array.from({ length: 30 }, (_, i) =>
      activity({ startedOn: BLOCK_START - (30 - i) * DAY_MS, sufferScore: 60 }),
    )
    const cold = summarise(window, BLOCK_START, day(6))
    const warm = summarise(window, BLOCK_START, day(6), runIn)
    expect(warm.fitness).toBeGreaterThan(cold.fitness)
  })
})

describe('percentDelta', () => {
  it('is a fraction, signed', () => {
    expect(percentDelta(120, 100)).toBeCloseTo(0.2, 10)
    expect(percentDelta(80, 100)).toBeCloseTo(-0.2, 10)
  })

  it('is null against nothing — there is no percentage above zero', () => {
    expect(percentDelta(50, 0)).toBeNull()
  })
})

describe('zone shares', () => {
  it('files each run by the zone its heart rate puts it in', () => {
    const shares = zoneShares(
      [
        activity({ averageHeartrate: 140, movingS: 3_000 }), // Z2
        activity({ averageHeartrate: 141, movingS: 1_800 }), // Z2
        activity({ averageHeartrate: 178, movingS: 1_200 }), // Z5
      ],
      HR_MAX,
    )
    expect(shares.find((s) => s.zone === 2)!.movingS).toBe(4_800)
    expect(shares.find((s) => s.zone === 5)!.movingS).toBe(1_200)
    expect(shares.find((s) => s.zone === 3)!.runs).toBe(0)
  })

  it('leaves out runs with no strap rather than guessing at them', () => {
    const shares = zoneShares([activity({ averageHeartrate: null })], HR_MAX)
    expect(shares.every((s) => s.runs === 0)).toBe(true)
  })

  it('says how much of the running it could actually see', () => {
    expect(
      zoneCoverage([
        activity({ averageHeartrate: 150, movingS: 3_000 }),
        activity({ averageHeartrate: null, movingS: 1_000 }),
      ]),
    ).toBeCloseTo(0.75, 5)
    expect(zoneCoverage([])).toBe(0)
  })

  it('always returns all five zones, so a legend never changes shape', () => {
    expect(zoneShares([], HR_MAX).map((s) => s.zone)).toEqual([1, 2, 3, 4, 5])
  })
})
