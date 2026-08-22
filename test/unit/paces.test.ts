import { describe, expect, it } from 'vitest'
import { HR_MAX, PACES, PACE_ZONE_NUMBER, ZONE_LABEL, hrZone, midPaceSKm, zoneTag } from '@/lib/paces'
import { decimal } from '@/lib/format'

describe('heart-rate zones', () => {
  it('puts the two races on record where a half and a 10K belong', () => {
    // docs/01 §: La Mitja 2026 was raced at 172 avg and El Tast at 176. A half is run at
    // threshold and a 10K just over it, so anything that reads those as Z3 is miscalibrated.
    expect(hrZone(172)).toBe(4)
    expect(hrZone(176)).toBe(4)
    // The final 3 km of that half climbed to 177–185 — over the line into Z5.
    expect(hrZone(180)).toBe(5)
    expect(hrZone(185)).toBe(5)
  })

  it('reads an easy run as Z2 and a jog as Z1', () => {
    expect(hrZone(150)).toBe(2)
    expect(hrZone(130)).toBe(1)
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
})

describe('decimal', () => {
  it('writes numbers the way Spain does', () => {
    expect(decimal(12.44)).toBe('12,4')
    expect(decimal(8)).toBe('8,0')
    expect(decimal(21.0975, 2)).toBe('21,10')
    expect(decimal(42.6, 0)).toBe('43')
  })
})
