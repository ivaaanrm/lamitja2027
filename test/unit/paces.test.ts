import { describe, expect, it } from 'vitest'
import {
  HR_MAX,
  PACES,
  PACE_ZONES,
  PACE_ZONE_NUMBER,
  ZONE_LABEL,
  bandsForGoalPace,
  hrZone,
  midPaceSKm,
  zoneTag,
} from '@/lib/paces'
import { DEFAULTS, clock } from '@/lib/config'
import { decimal } from '@/lib/format'

/** Goal pace at the default goal: 1:19:59 over 21 097,5 m — 227,467 s/km. */
const DEFAULT_GOAL_PACE =
  clock('PUBLIC_GOAL_TIME', undefined, DEFAULTS.goalTime) / (DEFAULTS.raceDistanceM / 1000)

describe('the bands are derived from the goal', () => {
  it('reproduces docs/03 §4 exactly at the default goal', () => {
    // The calibration point. Every ratio in `paces.ts` was divided out of these six pairs,
    // so if this drifts by a second the table has been edited rather than derived.
    expect(bandsForGoalPace(DEFAULT_GOAL_PACE)).toEqual({
      easy: { lo: 300, hi: 330 }, // 5:00–5:30
      long: { lo: 285, hi: 310 }, // 4:45–5:10
      steady: { lo: 260, hi: 275 }, // 4:20–4:35
      threshold: { lo: 230, hi: 238 }, // 3:50–3:58
      race: { lo: 225, hi: 227 }, // 3:45–3:47
      vo2: { lo: 210, hi: 220 }, // 3:30–3:40
    })
  })

  it('scales the whole table with a slower goal', () => {
    // 1:45:00 for the half is 4:58/km. An *offset* table would have handed this runner a
    // 6:11/km easy run and a 5:00/km "race pace" — the same seconds bolted onto a much
    // slower base. The ratios keep every band the same effort instead.
    const bands = bandsForGoalPace(6300 / (DEFAULTS.raceDistanceM / 1000))
    expect(bands.race).toEqual({ lo: 295, hi: 298 })
    expect(bands.easy).toEqual({ lo: 394, hi: 433 })
    expect(bands.vo2).toEqual({ lo: 276, hi: 289 })
  })

  it('keeps the bands ordered and non-empty at any goal', () => {
    for (const goalTimeS of [3600, 4799, 5400, 6300, 9000]) {
      const bands = bandsForGoalPace(goalTimeS / (DEFAULTS.raceDistanceM / 1000))
      const at = `${goalTimeS}s`
      for (const zone of PACE_ZONES) {
        expect(bands[zone].lo, `${zone} at ${at}`).toBeLessThan(bands[zone].hi)
        expect(bands[zone].lo, `${zone} at ${at}`).toBeGreaterThan(0)
      }
      // Faster to slower: the ordering is what every zone number below claims.
      expect(bands.vo2.lo, at).toBeLessThan(bands.race.lo)
      expect(bands.race.lo, at).toBeLessThan(bands.threshold.lo)
      expect(bands.threshold.lo, at).toBeLessThan(bands.steady.lo)
      expect(bands.steady.lo, at).toBeLessThan(bands.long.lo)
      expect(bands.long.lo, at).toBeLessThan(bands.easy.lo)
    }
  })
})

describe('heart-rate zones', () => {
  // These two read real bpm off two real races, so they only mean anything at the
  // athlete those races belong to. A fork with its own HR_MAX skips them.
  it.skipIf(HR_MAX !== DEFAULTS.hrMax)(
    'puts the two races on record where a half and a 10K belong',
    () => {
      // docs/01 §: La Mitja 2026 was raced at 172 avg and El Tast at 176. A half is run at
      // threshold and a 10K just over it, so anything that reads those as Z3 is miscalibrated.
      expect(hrZone(172)).toBe(4)
      expect(hrZone(176)).toBe(4)
      // The final 3 km of that half climbed to 177–185 — over the line into Z5.
      expect(hrZone(180)).toBe(5)
      expect(hrZone(185)).toBe(5)
    },
  )

  it.skipIf(HR_MAX !== DEFAULTS.hrMax)('reads an easy run as Z2 and a jog as Z1', () => {
    expect(hrZone(150)).toBe(2)
    expect(hrZone(130)).toBe(1)
  })

  it('opens each zone at the same share of any maximum', () => {
    // The floors are shares of HR_MAX, so these hold whoever is wearing the strap.
    expect(hrZone(Math.round(0.95 * HR_MAX))).toBe(5)
    expect(hrZone(Math.round(0.89 * HR_MAX))).toBe(4)
    expect(hrZone(Math.round(0.84 * HR_MAX))).toBe(3)
    expect(hrZone(Math.round(0.75 * HR_MAX))).toBe(2)
    expect(hrZone(Math.round(0.6 * HR_MAX))).toBe(1)
  })

  it('never leaves the five zones, however extreme the reading', () => {
    for (const bpm of [0, 40, 100, 160, 190, HR_MAX, 220]) {
      expect(hrZone(bpm), `${bpm} bpm`).toBeGreaterThanOrEqual(1)
      expect(hrZone(bpm), `${bpm} bpm`).toBeLessThanOrEqual(5)
    }
  })

  it('climbs monotonically — a faster heart is never a lower zone', () => {
    for (let bpm = 80; bpm < 210; bpm++) {
      expect(hrZone(bpm), `${bpm} bpm`).toBeGreaterThanOrEqual(hrZone(bpm - 1))
    }
  })
})

describe('pace zones', () => {
  it('gives every pace band a zone, and labels it with the same one', () => {
    for (const [zone, band] of Object.entries(PACES)) {
      const number = PACE_ZONE_NUMBER[zone as keyof typeof PACES]
      expect(ZONE_LABEL[zone as keyof typeof PACES], zone).toContain(zoneTag(number))
      expect(midPaceSKm(zone as keyof typeof PACES)).toBe((band.lo + band.hi) / 2)
    }
  })

  it('numbers the zones in the order the paces run', () => {
    // Slower band, lower zone — the ordering is the whole claim the numbers make.
    const byPace = (Object.keys(PACES) as (keyof typeof PACES)[]).sort(
      (a, b) => midPaceSKm(b) - midPaceSKm(a),
    )
    const zones = byPace.map((z) => PACE_ZONE_NUMBER[z])
    expect(zones).toEqual([...zones].sort((a, b) => a - b))
  })

  it('lists all six zones at runtime, in table order', () => {
    expect(PACE_ZONES).toEqual(['easy', 'long', 'steady', 'threshold', 'race', 'vo2'])
  })
})

describe('decimal', () => {
  it('writes numbers the way Spain does', () => {
    expect(decimal(12.44)).toBe('12,4')
    expect(decimal(8)).toBe('8,0')
    expect(decimal(21.0975, 2)).toBe('21,10')
    expect(decimal(42.6, 0)).toBe('43')
  })
})
