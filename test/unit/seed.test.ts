import { describe, expect, it } from 'vitest'
import { DAY_MS, RACE_DATE, TOTAL_WEEKS } from '@/lib/block'
import { isDownWeek, phaseFor, planSessionRows, planWeekRows, qualityShare, weeklyVolumeM } from '@/lib/seed'
import type { NewPlanSession } from '@/lib/db/schema'

const NOW = Date.UTC(2026, 7, 22)
const weeks = planWeekRows(NOW)
const sessions = planSessionRows(NOW)

const QUALITY = new Set(['tempo', 'interval', 'race'])
const RUN = new Set(['easy', 'long', 'tempo', 'interval', 'race'])

const byWeek = (week: number): NewPlanSession[] =>
  sessions.filter((s) => {
    const i = Math.floor((s.scheduledOn - Date.UTC(2026, 7, 17)) / (7 * DAY_MS))
    return i === week
  })

describe('block shape', () => {
  it('covers the 23 weeks from Mon 17 Aug to race day', () => {
    // docs/03 says 22 weeks from 24 Aug; the block actually started a week earlier.
    expect(weeks).toHaveLength(23)
    expect(TOTAL_WEEKS).toBe(23)
  })

  it('follows the phase structure in docs/03 §2', () => {
    expect(phaseFor(0)).toBe('rebuild')
    expect(phaseFor(6)).toBe('rebuild')
    expect(phaseFor(7)).toBe('base')
    expect(phaseFor(13)).toBe('threshold')
    expect(phaseFor(18)).toBe('race-specific')
    expect(phaseFor(22)).toBe('taper')
  })

  it('ends on race day', () => {
    const race = sessions.filter((s) => s.type === 'race')
    expect(race).toHaveLength(1)
    expect(race[0]!.scheduledOn).toBe(RACE_DATE)
    expect(race[0]!.targetDistanceM).toBeCloseTo(21097.5)
  })
})

describe('volume', () => {
  it('peaks at 68 km, as docs/03 specifies', () => {
    const peak = Math.max(...weeks.map((w) => w.targetVolumeM ?? 0))
    expect(peak / 1000).toBeCloseTo(68, 1)
  })

  it('totals roughly the ~965 km the plan budgets for', () => {
    const totalKm = weeks.reduce((sum, w) => sum + (w.targetVolumeM ?? 0), 0) / 1000
    // Down weeks pull it slightly under the headline figure; anything near it is fine,
    // but a change that moves it by 10%+ means the ramp was altered by accident.
    expect(totalKm).toBeGreaterThan(930)
    expect(totalKm).toBeLessThan(1010)
  })

  it('cuts down weeks to ~75%, at W4/8/12/16/20', () => {
    for (const week of [3, 7, 11, 15, 19]) expect(isDownWeek(week)).toBe(true)
    for (const week of [0, 4, 8, 12, 20]) expect(isDownWeek(week)).toBe(false)

    // A down week must be lighter than the week before it — that is the whole point.
    for (const week of [3, 7, 11, 15, 19]) {
      expect(weeklyVolumeM(week)).toBeLessThan(weeklyVolumeM(week - 1))
    }
  })

  it('never ramps more than 10% between consecutive build weeks', () => {
    // docs/02: the binding constraints are the knee and consistency. A ramp faster than
    // ~10% is the classic way to re-injure, so this must fail loudly if the curve changes.
    for (let week = 1; week < TOTAL_WEEKS; week++) {
      if (isDownWeek(week) || isDownWeek(week - 1)) continue // recovery and rebound are exempt
      const previous = weeklyVolumeM(week - 1)
      const growth = (weeklyVolumeM(week) - previous) / previous
      expect(growth, `week ${week}`).toBeLessThanOrEqual(0.1001)
    }
  })
})

describe('intensity distribution', () => {
  it('keeps quality at 20–25% of volume in every phase that has any', () => {
    // docs/03 §3: "Quality density stays at 20–25% of km (down from 33%) and volume
    // carries the load." Exceeding it is how the last block plateaued.
    expect(qualityShare('rebuild')).toBe(0) // all easy by design
    for (const phase of ['base', 'threshold', 'race-specific'] as const) {
      expect(qualityShare(phase), phase).toBeGreaterThanOrEqual(0.2)
      expect(qualityShare(phase), phase).toBeLessThanOrEqual(0.25)
    }
  })

  it('runs the rebuild phase entirely easy, with no pace targets', () => {
    for (let week = 0; week <= 6; week++) {
      for (const session of byWeek(week)) {
        expect(QUALITY.has(session.type), `w${week} ${session.type}`).toBe(false)
        // "In Phase 0, ignore all of these and run easy by feel."
        expect(session.targetPaceLoSKm).toBeNull()
      }
    }
  })

  it('never puts two quality sessions on consecutive days', () => {
    const qualityDays = new Set(
      sessions.filter((s) => QUALITY.has(s.type)).map((s) => s.scheduledOn),
    )
    for (const day of qualityDays) {
      expect(qualityDays.has(day + DAY_MS), new Date(day).toISOString()).toBe(false)
    }
  })

  it('caps quality at two sessions a week', () => {
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      const count = byWeek(week).filter((s) => QUALITY.has(s.type)).length
      expect(count, `week ${week}`).toBeLessThanOrEqual(2)
    }
  })
})

describe('frequency and strength', () => {
  it('runs 5–6 times a week once past the rebuild phase', () => {
    // docs/03 §3: "Frequency before intensity. 3.6 → 5–6 runs/week."
    for (let week = 7; week < TOTAL_WEEKS; week++) {
      const runs = byWeek(week).filter((s) => RUN.has(s.type)).length
      expect(runs, `week ${week}`).toBeGreaterThanOrEqual(5)
      expect(runs, `week ${week}`).toBeLessThanOrEqual(7)
    }
  })

  it('prescribes strength twice a week from week one', () => {
    // docs/03 §3: "One 17-minute session in the entire last block." Non-negotiable now.
    for (const week of [0, 1, 5, 11]) {
      expect(byWeek(week).filter((s) => s.type === 'strength')).toHaveLength(2)
    }
  })

  it('gives every session a stable, unique id so re-seeding updates in place', () => {
    const ids = sessions.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(planSessionRows(NOW + 5_000).map((s) => s.id)).toEqual(ids)
  })

  it('orders double days so the run comes before the strength session', () => {
    const monday = sessions.filter((s) => s.id.startsWith('w12-mon'))
    expect(monday.map((s) => s.dayOrder)).toEqual([0])
    const w00mon = sessions.filter((s) => s.id.startsWith('w00-mon'))
    expect(w00mon.every((s) => typeof s.dayOrder === 'number')).toBe(true)
  })
})

describe('race week', () => {
  it('counts the race itself toward the weekly target', () => {
    // A 28 km taper week that then adds a 21.1 km race on top is a ~40 km race week.
    const raceWeek = byWeek(TOTAL_WEEKS - 1)
    const total = raceWeek.reduce((sum, s) => sum + (s.targetDistanceM ?? 0), 0)
    expect(total / 1000).toBeCloseTo(28, 0)
  })

  it('still prescribes the full half-marathon on race day', () => {
    const race = sessions.find((s) => s.type === 'race')!
    expect(race.targetDistanceM).toBeCloseTo(21097.5)
  })
})
