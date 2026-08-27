import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HR_MAX,
  PACES,
  PACE_ZONES,
  PACE_ZONE_NUMBER,
  ZONE_LABEL,
  PACE_RATIO,
  paceBands,
  zoneFloorsBpm,
  hrZone,
  midPaceSKm,
  zoneTag,
} from '@/lib/paces'
import { DEFAULT_BLOCK, goalPaceSKm } from '@/lib/block'
import { DEFAULTS, clock } from '@/lib/config'
import { decimal } from '@/lib/format'

/** Goal pace at this deployment's own goal: 1:19:59 over 21 097,5 m — 227,467 s/km. */
const DEFAULT_GOAL_PACE = goalPaceSKm(DEFAULT_BLOCK)

describe('the bands are derived from the goal', () => {
  it('reproduces docs/03 §4 exactly at the default goal', () => {
    // The calibration point. Every ratio in `paces.ts` was divided out of these six pairs,
    // so if this drifts by a second the table has been edited rather than derived.
    expect(paceBands(DEFAULT_GOAL_PACE)).toEqual({
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
    const bands = paceBands(6300 / (DEFAULTS.raceDistanceM / 1000))
    expect(bands.race).toEqual({ lo: 295, hi: 298 })
    expect(bands.easy).toEqual({ lo: 394, hi: 433 })
    expect(bands.vo2).toEqual({ lo: 276, hi: 289 })
  })

  it('keeps the bands ordered and non-empty at any goal', () => {
    for (const goalTimeS of [3600, 4799, 5400, 6300, 9000]) {
      const bands = paceBands(goalTimeS / (DEFAULTS.raceDistanceM / 1000))
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
  it('puts the two races on record where a half and a 10K belong', () => {
    // docs/01 §: La Mitja 2026 was raced at 172 avg and El Tast at 176. A half is run at
    // threshold and a 10K just over it, so anything that reads those as Z3 is miscalibrated.
    expect(hrZone(172, DEFAULT_HR_MAX)).toBe(4)
    expect(hrZone(176, DEFAULT_HR_MAX)).toBe(4)
    // The final 3 km of that half climbed to 177–185 — over the line into Z5.
    expect(hrZone(180, DEFAULT_HR_MAX)).toBe(5)
    expect(hrZone(185, DEFAULT_HR_MAX)).toBe(5)
  })

  it('reads an easy run as Z2 and a jog as Z1', () => {
    expect(hrZone(150, DEFAULT_HR_MAX)).toBe(2)
    expect(hrZone(130, DEFAULT_HR_MAX)).toBe(1)
  })

  it('opens each zone at the same share of any maximum', () => {
    // The floors are shares, so the same *share* lands in the same zone whoever is wearing
    // the strap — which is the whole reason `hrZone` takes a maximum rather than reading a
    // constant. 178 is a plausible second athlete; the shares below are unchanged.
    for (const hrMax of [DEFAULT_HR_MAX, 178, 205]) {
      expect(hrZone(Math.round(0.95 * hrMax), hrMax), `${hrMax}`).toBe(5)
      expect(hrZone(Math.round(0.89 * hrMax), hrMax), `${hrMax}`).toBe(4)
      expect(hrZone(Math.round(0.84 * hrMax), hrMax), `${hrMax}`).toBe(3)
      expect(hrZone(Math.round(0.75 * hrMax), hrMax), `${hrMax}`).toBe(2)
      expect(hrZone(Math.round(0.6 * hrMax), hrMax), `${hrMax}`).toBe(1)
    }
  })

  it('reads one bpm differently for two athletes', () => {
    // 160 bpm is Z3 for a 192 max and Z4 for a 178 one. Reading it off a shared constant
    // is exactly the bug this signature exists to make impossible.
    expect(hrZone(160, 192)).toBe(3)
    expect(hrZone(160, 178)).toBe(4)
  })

  it('never leaves the five zones, however extreme the reading', () => {
    for (const bpm of [0, 40, 100, 160, 190, DEFAULT_HR_MAX, 220]) {
      expect(hrZone(bpm, DEFAULT_HR_MAX), `${bpm} bpm`).toBeGreaterThanOrEqual(1)
      expect(hrZone(bpm, DEFAULT_HR_MAX), `${bpm} bpm`).toBeLessThanOrEqual(5)
    }
  })

  it('climbs monotonically — a faster heart is never a lower zone', () => {
    for (let bpm = 80; bpm < 210; bpm++) {
      expect(hrZone(bpm, DEFAULT_HR_MAX), `${bpm} bpm`).toBeGreaterThanOrEqual(
        hrZone(bpm - 1, DEFAULT_HR_MAX),
      )
    }
  })

  it('reads the same beat differently against a different maximum', () => {
    // The whole reason hrMax is an argument: 180 is Z5 for a 192 max and only Z4 for 200.
    expect(hrZone(180, DEFAULT_HR_MAX)).toBe(5)
    expect(hrZone(180, 200)).toBe(4)
    expect(hrZone(160, 175)).toBe(4)
  })
})

describe('zoneFloorsBpm', () => {
  it('is the owner’s five lines, in bpm', () => {
    expect(zoneFloorsBpm(DEFAULT_HR_MAX)).toEqual({ 2: 138, 3: 157, 4: 167, 5: 177 })
  })

  it('rises with the zone and scales with the maximum', () => {
    for (const hrMax of [175, DEFAULT_HR_MAX, 205]) {
      const floors = zoneFloorsBpm(hrMax)
      expect(floors[2]).toBeLessThan(floors[3])
      expect(floors[3]).toBeLessThan(floors[4])
      expect(floors[4]).toBeLessThan(floors[5])
      expect(floors[5]).toBeLessThan(hrMax)
    }
    expect(zoneFloorsBpm(205)[4]).toBeGreaterThan(zoneFloorsBpm(175)[4])
  })
})

describe('pace bands', () => {
  it('still prescribes docs/03 §4 to the second for the owner’s goal', () => {
    // The bands stopped being literals and became ratios of goal pace. This is the test
    // that says the arithmetic changed and the prescription did not.
    const table = {
      easy: { lo: 300, hi: 330 },
      long: { lo: 285, hi: 310 },
      steady: { lo: 260, hi: 275 },
      threshold: { lo: 230, hi: 238 },
      race: { lo: 225, hi: 227 },
      vo2: { lo: 210, hi: 220 },
    }
    expect(paceBands(goalPaceSKm(DEFAULT_BLOCK))).toEqual(table)
    expect(PACES).toEqual(table)
  })

  it('moves the whole table when the goal moves', () => {
    // 45:00 for 10 km — a slower athlete gets slower bands, not the owner's.
    expect(paceBands(270)).toEqual({
      easy: { lo: 356, hi: 392 },
      long: { lo: 338, hi: 368 },
      steady: { lo: 309, hi: 326 },
      threshold: { lo: 273, hi: 283 },
      race: { lo: 267, hi: 269 },
      vo2: { lo: 249, hi: 261 },
    })
  })

  it('prescribes whole seconds, in order, whatever the goal', () => {
    for (const goal of [200, 227.46770944424694, 270, 330]) {
      const bands = paceBands(goal)
      for (const zone of PACE_ZONES) {
        expect(Number.isInteger(bands[zone].lo), `${zone} lo @ ${goal}`).toBe(true)
        expect(Number.isInteger(bands[zone].hi), `${zone} hi @ ${goal}`).toBe(true)
        expect(bands[zone].lo, `${zone} @ ${goal}`).toBeLessThan(bands[zone].hi)
      }
      // Fastest to slowest, the order the five zones are numbered in.
      const mids = PACE_ZONES.map((z) => (bands[z].lo + bands[z].hi) / 2)
      const byZone = PACE_ZONES.map((z) => PACE_ZONE_NUMBER[z])
      for (let i = 0; i < mids.length; i++) {
        for (let j = 0; j < mids.length; j++) {
          if (byZone[i]! < byZone[j]!) expect(mids[i], `${goal}`).toBeGreaterThan(mids[j]!)
        }
      }
    }
  })

  it('holds race pace at the goal it was set from', () => {
    // Race pace is the target itself: the band closes on it rather than straddling it,
    // because 1:19:59 is the slowest run that counts as a sub-1:20.
    expect(PACE_RATIO.race.hi).toBeLessThanOrEqual(1)
    expect(PACE_RATIO.race.hi).toBeGreaterThan(0.99)
    expect(PACE_RATIO.vo2.hi).toBeLessThan(PACE_RATIO.race.lo)
    expect(PACE_RATIO.easy.lo).toBeGreaterThan(PACE_RATIO.threshold.hi)
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
