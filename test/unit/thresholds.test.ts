import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOCK, WEEK_MS, totalWeeks, type BlockConfig } from '@/lib/block'
import { DEFAULT_HR_MAX } from '@/lib/paces'
import {
  domains,
  domainsByWeek,
  estimateThresholds,
  thresholdSeries,
} from '@/lib/thresholds'
import type { Activity } from '@/lib/db/schema'

const HR_MAX = DEFAULT_HR_MAX // 192, the owner's fallback

/**
 * One activity row, from the four numbers this estimator actually reads.
 *
 * Dates are `YYYY-MM-DD` parsed as UTC midnight, which is the app's wall-clock convention
 * everywhere else — see `block.ts`.
 */
const run = (
  id: number,
  date: string,
  distanceM: number,
  movingS: number,
  hr: number | null,
  maxHr: number | null = null,
  sportType = 'Run',
): Activity => ({
  id,
  userId: 'owner',
  name: `run-${id}`,
  sportType,
  startedOn: Date.parse(`${date}T00:00:00Z`),
  distanceM,
  movingS,
  elevationGainM: 0,
  averageHeartrate: hr,
  maxHeartrate: maxHr,
  cadenceSpm: 168,
  sufferScore: null,
  updatedAt: 0,
})

/**
 * Six real rows out of the owner's 2025-26 build, read off Strava.
 *
 * This is the fixture the whole module was calibrated against and it is worth saying why
 * these six: they span 2:55/km of pace and 35 beats of heart rate, they include two
 * genuine races eleven weeks apart at nearly the same pace over very different durations,
 * and they include three sessions whose average heart rate is *not* a threshold — a tempo
 * buried in a warm-up, and two progressive runs. So they exercise both halves of the
 * estimate: the line has real spread to fit through, and the effort filter has real
 * near-misses to reject.
 *
 * Ground truth, from `docs/01`: the half was raced at 172 average, the 10K at 176, and the
 * maximum ever seen is 191.
 */
const BUILD_2025_26: Activity[] = [
  run(1, '2025-10-25', 10033.5, 2382, 176, 191), // El Tast 10K, 39:42
  run(2, '2025-11-14', 8005.6, 2737, 140.9, 154), // easy, Donosti
  run(3, '2025-11-28', 11030.3, 3143, 156.0, 182), // 4 km tempo inside an easy run
  run(4, '2025-12-16', 10818.3, 2863, 165.4, 185), // progressive
  run(5, '2025-12-28', 19009.1, 5584, 157.6, 181), // long run, progressive
  run(6, '2026-01-18', 21192.4, 5037, 172, 185), // La Mitja, 1:23:57
]

/** A week after the half, with a window wide enough to hold all six. */
const AFTER_THE_HALF = Date.parse('2026-01-19T00:00:00Z')

describe('estimateThresholds against the owner’s real season', () => {
  const estimate = estimateThresholds(BUILD_2025_26, HR_MAX, AFTER_THE_HALF, 16)

  it('lands LT2 where two independent races put it', () => {
    // The half (84 min at 172) and the 10K (40 min at 176) are the same athlete eleven
    // weeks apart. Corrected to the hour they resolve to 174.0 and 173.5 — which is the
    // real test here, because nothing was fitted to make them agree.
    expect(estimate.lt2.bpm).toBe(174)
    expect(estimate.lt2.basis).toBe('measured')
    expect(estimate.lt2.shareOfMax).toBeCloseTo(0.906, 2)
  })

  it('puts a threshold pace under it that the athlete has actually run', () => {
    // A 1:23:57 half is 3:57.6/km, and threshold pace should sit a hair inside that.
    expect(estimate.lt2.paceSKm).not.toBeNull()
    expect(estimate.lt2.paceSKm!).toBeGreaterThan(225)
    expect(estimate.lt2.paceSKm!).toBeLessThan(240)
  })

  it('rejects the sessions whose average heart rate is not a threshold', () => {
    // Only the two races survive the steadiness filter. The 4 km tempo averages 156 over a
    // run whose tempo kilometres were run at 177 — its spread is 26 beats, and taking its
    // average as evidence would understate LT2 by nearly twenty.
    expect(estimate.evidence.map((e) => e.activityId).sort()).toEqual([1, 6])
  })

  it('fits a cardiac cost line the scatter actually supports', () => {
    expect(estimate.line).not.toBeNull()
    expect(estimate.line!.r).toBeGreaterThan(0.9)
    expect(estimate.line!.slopeBpmPerMs).toBeGreaterThan(0)
    expect(estimate.confidence).toBe('alta')
  })

  it('places LT1 above easy running and below LT2', () => {
    // His easy running sits at 141–150; LT1 has to be above that and clear of LT2.
    expect(estimate.lt1.bpm).toBeGreaterThan(150)
    expect(estimate.lt1.bpm).toBeLessThan(estimate.lt2.bpm - 5)
    expect(estimate.lt1.shareOfMax).toBeGreaterThan(0.72)
    expect(estimate.lt1.shareOfMax).toBeLessThan(0.86)
  })

  it('reports the highest beat the strap saw, so a wrong FCmáx is visible', () => {
    expect(estimate.observedMaxBpm).toBe(191)
  })
})

describe('degrading', () => {
  it('answers from FCmáx alone when there is nothing at all', () => {
    const estimate = estimateThresholds([], HR_MAX, AFTER_THE_HALF)
    expect(estimate.lt2.basis).toBe('hrmax')
    expect(estimate.lt2.bpm).toBe(Math.round(0.9 * HR_MAX))
    expect(estimate.lt1.basis).toBe('anchored')
    expect(estimate.confidence).toBe('baja')
    // No line means no pace — a bpm with an invented pace under it is worse than a blank.
    expect(estimate.line).toBeNull()
    expect(estimate.lt2.paceSKm).toBeNull()
  })

  it('shrinks a lone freak effort towards the prior instead of believing it', () => {
    // The real first run back from the 2026 knee lay-off: 8.16 km at 4:44/km, 39 minutes,
    // 181.6 average on a dry strap in August. Taken at face value that is a threshold at
    // 93% of maximum on the strength of one afternoon.
    const alone = [run(10, '2026-08-18', 8160, 2316, 181.6, 193)]
    const estimate = estimateThresholds(alone, HR_MAX, Date.parse('2026-08-30T00:00:00Z'))

    expect(estimate.evidence).toHaveLength(1)
    expect(estimate.lt2.bpm).toBeLessThan(178)
    expect(estimate.lt2.bpm).toBeGreaterThan(Math.round(0.9 * HR_MAX))
  })

  it('refuses a line when every run was at the same speed', () => {
    // Eight identical easy runs: no spread on the x axis, so any slope through them is
    // noise — and an inverted noisy slope is an arbitrarily wrong threshold pace.
    const flat = Array.from({ length: 8 }, (_, i) =>
      run(20 + i, `2026-08-${String(2 + i).padStart(2, '0')}`, 10000, 3000, 145 + (i % 2), 158),
    )
    expect(estimateThresholds(flat, HR_MAX, Date.parse('2026-08-30T00:00:00Z')).line).toBeNull()
  })

  it('ignores rides, which cost fewer beats per unit speed than running', () => {
    const rides = BUILD_2025_26.map((a) => ({ ...a, sportType: 'Ride' }))
    expect(estimateThresholds(rides, HR_MAX, AFTER_THE_HALF, 16).sampleRuns).toBe(0)
  })

  it('drops runs that fell out of the window', () => {
    // The default window is twelve weeks, which by mid-March holds none of the build.
    const late = estimateThresholds(BUILD_2025_26, HR_MAX, Date.parse('2026-05-01T00:00:00Z'))
    expect(late.sampleRuns).toBe(0)
    expect(late.lt2.basis).toBe('hrmax')
  })
})

describe('the breakpoint', () => {
  it('recovers a bend the scatter really has', () => {
    // A synthetic ramp with a deliberate knee at 3.60 m/s: 18 bpm per m/s below it and 40
    // above, on an intercept of 95, so the true breakpoint is 95 + 18 × 3.6 = 159.8.
    const bent = Array.from({ length: 24 }, (_, i) => {
      const v = 2.7 + i * 0.06
      const hr = v <= 3.6 ? 95 + 18 * v : 95 + 18 * 3.6 + 40 * (v - 3.6)
      return run(100 + i, `2026-08-${String(2 + (i % 27)).padStart(2, '0')}`, v * 2400, 2400, hr, hr + 8)
    })

    const estimate = estimateThresholds(bent, 200, Date.parse('2026-08-30T00:00:00Z'))
    expect(estimate.lt1.basis).toBe('measured')
    expect(estimate.lt1.bpm).toBeGreaterThan(155)
    expect(estimate.lt1.bpm).toBeLessThan(165)
  })

  it('does not invent one in a scatter that is straight', () => {
    // The owner's own six rows are very nearly linear (r ≈ 0.98). Two extra parameters
    // always fit better; the gain threshold is what stops that being called a finding.
    expect(
      estimateThresholds(BUILD_2025_26, HR_MAX, AFTER_THE_HALF, 16).lt1.basis,
    ).toBe('anchored')
  })
})

describe('thresholdSeries', () => {
  const BLOCK: BlockConfig = { ...DEFAULT_BLOCK, startsOn: Date.parse('2025-10-20T00:00:00Z') }

  it('is computed from what was known at the time, not back-projected', () => {
    const series = thresholdSeries(BLOCK, BUILD_2025_26, HR_MAX, AFTER_THE_HALF)
    expect(series.length).toBeGreaterThan(0)

    // The 10K is in week 0 and the half in week 12, so no week before the half may carry
    // an estimate that has seen it. Week 0's LT2 rests on the 10K alone.
    const first = series[0]!
    expect(first.weekIndex).toBe(0)
    expect(first.lt2Bpm).toBeGreaterThan(0)

    // And the estimate must never run past today.
    expect(series.at(-1)!.weekIndex).toBeLessThanOrEqual(
      Math.floor((AFTER_THE_HALF - BLOCK.startsOn) / WEEK_MS),
    )
  })

  it('opens where the evidence does rather than on a run of textbook defaults', () => {
    const series = thresholdSeries(BLOCK, [], HR_MAX, AFTER_THE_HALF)
    expect(series).toEqual([])
  })
})

describe('domains', () => {
  const split = { lt1: { bpm: 155 }, lt2: { bpm: 174 } } as Parameters<typeof domains>[1]

  it('splits recorded time at the two thresholds', () => {
    const result = domains(BUILD_2025_26, split)
    // Only the easy run is under 155. Only the 10K, at 176, is over 174 — the half
    // averaged 172, which puts an 84-minute race in the moderate domain and is exactly
    // right: a half is run at threshold, which means just under it.
    expect(result.easyS).toBe(2737)
    expect(result.moderateS).toBe(3143 + 2863 + 5584 + 5037)
    expect(result.hardS).toBe(2382)
    expect(result.totalS).toBe(result.easyS + result.moderateS + result.hardS)
    expect(result.easyShare).toBeCloseTo(2737 / result.totalS, 6)
  })

  it('leaves out runs with no heart rate rather than guessing at them', () => {
    const result = domains([run(30, '2026-01-05', 10000, 3000, null)], split)
    expect(result.totalS).toBe(0)
    expect(result.easyShare).toBe(0)
  })

  it('gives every block week a row, run or not', () => {
    const block: BlockConfig = { ...DEFAULT_BLOCK, startsOn: Date.parse('2025-10-20T00:00:00Z') }
    const weeks = domainsByWeek(block, BUILD_2025_26, split, totalWeeks(block))
    expect(weeks).toHaveLength(totalWeeks(block))
    // Week 0 holds the 10K and nothing else.
    expect(weeks[0]!.hardS).toBe(2382)
    // Week 1 was not run.
    expect(weeks[1]!.totalS).toBe(0)
  })
})
