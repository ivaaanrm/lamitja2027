import { describe, expect, it } from 'vitest'
import { BLOCK_START, DAY_MS, RACE_DATE, TOTAL_WEEKS, WEEK_MS } from '@/lib/block'
import { SESSION_META, isQuality } from '@/lib/plan'
import { buildPlan, hardShare, isDownWeek, phaseFor, weeklyVolumeM } from '@/lib/seed'
import { hardDistanceM, workoutDistanceM } from '@/lib/workout'
import type { NewPlanSession } from '@/lib/db/schema'

const NOW = Date.UTC(2026, 7, 22)
const { weeks, sessions } = buildPlan(NOW)

const RUN = new Set(['easy', 'long', 'tempo', 'interval', 'fartlek', 'race'])

const weekOf = (at: number) => Math.floor((at - BLOCK_START) / WEEK_MS)
const byWeek = (week: number): NewPlanSession[] =>
  sessions.filter((s) => weekOf(s.scheduledOn) === week)

/** Every week's running sessions, the ones that carry a distance. */
const runsIn = (week: number) =>
  byWeek(week).filter((s) => RUN.has(s.type) && (s.targetDistanceM ?? 0) > 0)

const prescribedKm = (week: number) =>
  byWeek(week).reduce((sum, s) => sum + (SESSION_META[s.type].countsAsVolume ? (s.targetDistanceM ?? 0) : 0), 0) / 1000

describe('block shape', () => {
  it('covers the 23 weeks from Mon 17 Aug to race day', () => {
    // docs/03 says 22 weeks from 24 Aug; the block actually started a week earlier.
    expect(weeks).toHaveLength(23)
    expect(TOTAL_WEEKS).toBe(23)
  })

  it('follows the phase structure in docs/03 §2', () => {
    expect(phaseFor(0)).toBe('reconstrucción')
    expect(phaseFor(6)).toBe('reconstrucción')
    expect(phaseFor(7)).toBe('base')
    expect(phaseFor(13)).toBe('umbral')
    expect(phaseFor(18)).toBe('específico')
    expect(phaseFor(22)).toBe('puesta a punto')
  })

  it('never opens a phase on a cutback week', () => {
    // A down week is for absorbing the phase behind it, not for introducing the one
    // ahead — the step up in volume is what defines a new phase.
    for (const first of [0, 7, 13, 18, 21]) expect(isDownWeek(first), `week ${first}`).toBe(false)
  })

  it('ends on race day, over the full half marathon', () => {
    const race = sessions.find((s) => s.scheduledOn === RACE_DATE && s.type === 'race')!
    expect(race.title).toBe('La Mitja de Granollers')
    expect(race.steps!.some((step) => step.distanceM === 21097.5 && step.zone === 'race')).toBe(true)
    expect(race.targetPaceLoSKm).toBe(3 * 60 + 45)
  })
})

describe('volume', () => {
  it('peaks at 68 km, as docs/03 specifies', () => {
    const peak = Math.max(...weeks.map((w) => w.targetVolumeM ?? 0))
    expect(peak / 1000).toBeCloseTo(68, 1)
  })

  it('totals roughly the ~965 km the plan budgets for', () => {
    const totalKm = weeks.reduce((sum, w) => sum + (w.targetVolumeM ?? 0), 0) / 1000
    // A change that moves this by 10%+ means the ramp was altered by accident.
    expect(totalKm).toBeGreaterThan(930)
    expect(totalKm).toBeLessThan(1010)
  })

  it('stores a target that the week’s own sessions actually add up to', () => {
    // The stored target is the sum of what is prescribed, not the ramp figure the easy
    // runs were sized from. A target no session adds up to stops meaning anything.
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(prescribedKm(week), `week ${week}`).toBeCloseTo((weeks[week]!.targetVolumeM ?? 0) / 1000, 3)
    }
  })

  it('lands on the ramp in every week but the last', () => {
    for (let week = 0; week < TOTAL_WEEKS - 1; week++) {
      expect(prescribedKm(week), `week ${week}`).toBeCloseTo(weeklyVolumeM(week) / 1000, 3)
    }
    // Race week is prescribed outright: the ramp says 28 km, of which the race is 21.1,
    // and seven kilometres across the six days before it is a shutdown, not a taper.
    expect(prescribedKm(TOTAL_WEEKS - 1)).toBeGreaterThan(34)
    expect(prescribedKm(TOTAL_WEEKS - 1)).toBeLessThan(42)
  })

  it('cuts down weeks to ~75%, following docs/03 §2', () => {
    for (const week of [3, 8, 12, 16, 20]) expect(isDownWeek(week)).toBe(true)
    for (const week of [0, 4, 7, 13, 17]) expect(isDownWeek(week)).toBe(false)

    // A down week must be lighter than the week before it — that is the whole point.
    for (const week of [3, 8, 12, 16, 20]) {
      expect(weeklyVolumeM(week), `week ${week}`).toBeLessThan(weeklyVolumeM(week - 1))
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

  it('grows the long run without ever jumping it', () => {
    // Measured against the longest so far rather than last week's, because a checkpoint
    // race replaces the long run outright and a down week deliberately shortens it —
    // neither is a step backwards the next long run has to climb out of.
    const longRun = (week: number) =>
      Math.max(0, ...byWeek(week).filter((s) => s.type === 'long').map((s) => s.targetDistanceM ?? 0))

    expect(longRun(0) / 1000).toBe(8)
    expect(longRun(17) / 1000).toBe(22) // peak week
    expect(longRun(6), 'the Phase 0 gate replaces its long run').toBe(0)

    let ceiling = longRun(0) // the block opens where it opens; growth starts after it
    for (let week = 1; week < TOTAL_WEEKS; week++) {
      const distance = longRun(week)
      if (distance === 0 || isDownWeek(week)) continue
      expect(distance - ceiling, `week ${week}`).toBeLessThanOrEqual(3000)
      ceiling = Math.max(ceiling, distance)
    }
  })
})

describe('every session carries its variables', () => {
  it('gives every run a distance and a workout', () => {
    for (const session of sessions.filter((s) => RUN.has(s.type))) {
      expect(session.steps, session.id).not.toBeNull()
      expect(session.targetDistanceM, session.id).toBeGreaterThan(0)
      expect(session.targetDistanceM, session.id).toBe(workoutDistanceM(session.steps!))
    }
  })

  it('gives every rep set a count and a recovery', () => {
    const sets = sessions.flatMap((s) => (s.steps ?? []).filter((step) => step.kind === 'rep'))
    expect(sets.length).toBeGreaterThanOrEqual(15)
    for (const set of sets) {
      expect(set.reps).toBeGreaterThan(1)
      expect(set.recovery).not.toBeNull()
      expect(set.distanceM ?? set.durationS).toBeGreaterThan(0)
      expect(set.zone, 'a repetition without a pace is not a prescription').not.toBeNull()
    }
  })

  it('gives every quality session a pace band and a warm-up', () => {
    for (const session of sessions.filter((s) => isQuality(s.type))) {
      expect(session.targetPaceLoSKm, session.id).not.toBeNull()
      expect(session.targetPaceHiSKm, session.id).not.toBeNull()
      expect(session.steps![0]!.kind, session.id).toBe('warmup')
    }
  })

  it('measures strength and cross-training in minutes, never in kilometres', () => {
    for (const session of sessions.filter((s) => s.type === 'strength' || s.type === 'cross')) {
      expect(session.targetDurationS, session.id).toBeGreaterThan(0)
      expect(session.targetDistanceM, session.id).toBeNull()
    }
  })

  it('gives every session a stable, unique id so re-seeding updates in place', () => {
    const ids = sessions.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(buildPlan(NOW + 5_000).sessions.map((s) => s.id)).toEqual(ids)
  })

  it('never puts a rest day on a day that already has a session', () => {
    for (const session of sessions.filter((s) => s.type === 'rest')) {
      const sameDay = sessions.filter((s) => s.scheduledOn === session.scheduledOn)
      expect(sameDay.map((s) => s.type), session.id).toEqual(['rest'])
    }
  })

  it('orders a double day so the run comes before the strength session', () => {
    const friday = byWeek(13).filter((s) => s.id.startsWith('w13-fri'))
    expect(friday.map((s) => s.type)).toEqual(['tempo', 'strength'])
    expect(friday.map((s) => s.dayOrder)).toEqual([0, 1])
  })
})

describe('intensity distribution', () => {
  it('runs the rebuild phase easy and by feel, up to the gate time trial', () => {
    // docs/03 §4: "In Phase 0, ignore all of these and run easy by feel."
    for (let week = 0; week <= 6; week++) {
      for (const session of byWeek(week)) {
        if (session.type === 'race') continue // the W7 gate is a test, not training
        expect(isQuality(session.type), `w${week} ${session.type}`).toBe(false)
        expect(session.targetPaceLoSKm, session.id).toBeNull()
      }
    }
  })

  it('keeps hard running under a quarter of the week until the race-specific phase', () => {
    // docs/03 §3: volume carries the load, quality does not. Hard metres are what is run
    // at threshold or faster — the warm-up and the recovery jogs of a rep session are not
    // quality, which is why this is not simply the distance of the quality sessions.
    for (let week = 0; week < 18; week++) {
      if (byWeek(week).some((s) => s.type === 'race')) continue // a race week is not a training week
      expect(hardShare(week), `week ${week}`).toBeLessThanOrEqual(0.25)
    }
    // Phase 3 is race-pace by design — docs/03 §2, "Everything at 3:47/km".
    for (const week of [18, 19, 21]) expect(hardShare(week), `week ${week}`).toBeLessThanOrEqual(0.35)
  })

  it('never puts two quality sessions on consecutive days', () => {
    // docs/03 §6: "Never two hard days back-to-back."
    const qualityDays = new Set(sessions.filter((s) => isQuality(s.type)).map((s) => s.scheduledOn))
    for (const day of qualityDays) {
      expect(qualityDays.has(day + DAY_MS), new Date(day).toISOString()).toBe(false)
    }
  })

  it('caps quality at two sessions a week', () => {
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(byWeek(week).filter((s) => isQuality(s.type)).length, `week ${week}`).toBeLessThanOrEqual(2)
    }
  })

  it('never adds volume and intensity in the same week', () => {
    // docs/03 §6. A week that both steps up and sharpens is how the knee went last time.
    for (let week = 1; week < TOTAL_WEEKS - 1; week++) {
      if (byWeek(week).some((s) => s.type === 'race')) continue // a race is a test, not a load
      const grew = weeklyVolumeM(week) > weeklyVolumeM(week - 1)
      const sharper = hardShare(week) > hardShare(week - 1) + 0.05
      expect(grew && sharper, `week ${week}`).toBe(false)
    }
  })
})

describe('frequency and strength', () => {
  it('runs 5–6 times a week once past the rebuild phase', () => {
    // docs/03 §3: "Frequency before intensity. 3.6 → 5–6 runs/week."
    for (let week = 7; week < TOTAL_WEEKS; week++) {
      expect(runsIn(week).length, `week ${week}`).toBeGreaterThanOrEqual(5)
      expect(runsIn(week).length, `week ${week}`).toBeLessThanOrEqual(7)
    }
  })

  it('prescribes strength twice a week, every week up to race week', () => {
    // docs/03 §3: "One 17-minute session in the entire last block." Non-negotiable now.
    for (let week = 0; week < TOTAL_WEEKS - 1; week++) {
      expect(byWeek(week).filter((s) => s.type === 'strength'), `week ${week}`).toHaveLength(2)
    }
    // Race week keeps one, and it is mobility rather than load.
    expect(byWeek(TOTAL_WEEKS - 1).filter((s) => s.type === 'strength')).toHaveLength(1)
  })

  it('uses cycling as the impact-free load through the rebuild phase', () => {
    // docs/03 §6: "Cycling is the pressure valve."
    for (let week = 0; week <= 6; week++) {
      expect(byWeek(week).filter((s) => s.type === 'cross'), `week ${week}`).toHaveLength(1)
    }
  })
})

describe('checkpoints', () => {
  const races = sessions.filter((s) => s.type === 'race')

  it('schedules all four checkpoints from docs/03 §5, plus the race', () => {
    expect(races.map((r) => weekOf(r.scheduledOn))).toEqual([6, 9, 15, 20, 22])
    // Every one of them lands on a Sunday.
    for (const race of races) expect(new Date(race.scheduledOn).getUTCDay()).toBe(0)
  })

  it('carries the marker pace each checkpoint has to hit', () => {
    // docs/03 §5, getting faster each time: 40:30 → 38:30 → 37:00 → 36:15.
    const markers = races.slice(0, 4).map((r) => r.targetPaceLoSKm!)
    for (let i = 1; i < markers.length; i++) expect(markers[i]!).toBeLessThan(markers[i - 1]!)
    // The race itself is 21.1 km, so its band is slower than any of the 10K markers.
    expect(races.at(-1)!.targetPaceLoSKm).toBe(3 * 60 + 45)
  })

  it('warms up and jogs down around every checkpoint', () => {
    for (const race of races.slice(0, 4)) {
      expect(race.steps![0]!.kind, race.id).toBe('warmup')
      expect(race.steps!.at(-1)!.kind, race.id).toBe('cooldown')
      expect(hardDistanceM(race.steps!), race.id).toBe(0) // a race carries no band; it is run flat out
    }
  })
})
