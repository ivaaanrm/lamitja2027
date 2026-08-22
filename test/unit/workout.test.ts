import { describe, expect, it } from 'vitest'
import { PACES } from '@/lib/paces'
import {
  cooldown,
  effortMetres,
  forMinutes,
  formatDistance,
  formatSeconds,
  formatStep,
  formatWorkout,
  hardDistanceM,
  jogFor,
  jogOver,
  km,
  primaryZone,
  reps,
  steady,
  strides,
  warmup,
  workoutDistanceM,
  workoutDurationS,
} from '@/lib/workout'

describe('distance', () => {
  it('counts every rep and the jogs between them, but not one after the last', () => {
    // 5 × 1 km with 90 s jog is 5 km of work plus four jogs, not five.
    const set = reps(5, { distanceM: km(1) }, 'vo2', jogOver(400))
    expect(workoutDistanceM([set])).toBe(5000 + 4 * 400)
    expect(effortMetres(set)).toBe(5000)
  })

  it('costs a timed rep at its own band and the jog at easy pace', () => {
    // 8 × 1 min at threshold (3:54/km mid-band) with a 1 min float at 5:30/km.
    const set = reps(8, { durationS: 60 }, 'threshold', jogFor(60))
    const perRep = (60 / ((PACES.threshold.lo + PACES.threshold.hi) / 2)) * 1000
    const perFloat = (60 / PACES.easy.hi) * 1000
    expect(workoutDistanceM([set])).toBe(Math.round(perRep * 8 + perFloat * 7))
  })

  it('treats a standing recovery as no distance at all', () => {
    const standing = reps(4, { distanceM: 400 }, 'vo2', {
      kind: 'standing',
      distanceM: null,
      durationS: 120,
    })
    expect(workoutDistanceM([standing])).toBe(1600)
  })

  it('totals a whole session', () => {
    const session = [warmup(km(3)), reps(5, { distanceM: km(1) }, 'vo2', jogOver(400)), cooldown(km(2))]
    expect(workoutDistanceM(session)).toBe(3000 + 6600 + 2000)
  })

  it('gives strides a distance so a week with them does not overshoot', () => {
    expect(workoutDistanceM([strides(6)])).toBe(600)
  })
})

describe('duration', () => {
  it('estimates a distance step from its band', () => {
    // 10 km at the long-run band's mid-point, 4:57.5/km.
    const mid = (PACES.long.lo + PACES.long.hi) / 2
    expect(workoutDurationS([steady(km(10), 'long')])).toBe(Math.round(10 * mid))
  })

  it('takes a timed step at its word', () => {
    expect(workoutDurationS([forMinutes(20, 'threshold')])).toBe(1200)
  })

  it('falls back to easy pace when there is no band — Phase 0 runs by feel', () => {
    const mid = (PACES.easy.lo + PACES.easy.hi) / 2
    expect(workoutDurationS([steady(km(8), null)])).toBe(Math.round(8 * mid))
  })
})

describe('hard metres', () => {
  it('counts the reps and excludes the warm-up, cool-down and jogs', () => {
    const session = [warmup(km(3)), reps(5, { distanceM: km(1) }, 'vo2', jogOver(400)), cooldown(km(2))]
    expect(hardDistanceM(session)).toBe(5000)
    expect(workoutDistanceM(session)).toBe(11600)
  })

  it('ignores easy and long-run steps entirely', () => {
    expect(hardDistanceM([steady(km(20), 'long'), steady(km(6), 'easy')])).toBe(0)
  })

  it('counts a race-pace finish inside a long run', () => {
    expect(hardDistanceM([steady(km(12), 'long'), steady(km(10), 'race'), cooldown(km(2))])).toBe(10000)
  })
})

describe('primary zone', () => {
  it('is the widest effort, not the warm-up', () => {
    expect(primaryZone([warmup(km(3)), reps(5, { distanceM: km(1) }, 'vo2', jogFor(90))])).toBe('vo2')
  })

  it('is the race-pace block in a long run that ends at race pace', () => {
    expect(primaryZone([steady(km(9), 'long'), steady(km(10), 'race')])).toBe('race')
  })

  it('is null when nothing carries a band', () => {
    expect(primaryZone([steady(km(8), null)])).toBeNull()
  })
})

describe('formatting', () => {
  it('says distances the way a runner does', () => {
    expect(formatDistance(400)).toBe('400 m')
    expect(formatDistance(1000)).toBe('1 km')
    expect(formatDistance(1200)).toBe('1,2 km')
    expect(formatDistance(21098)).toBe('21,1 km')
  })

  it('says durations the way a runner does', () => {
    expect(formatSeconds(20)).toBe('20 s')
    expect(formatSeconds(90)).toBe('90 s')
    expect(formatSeconds(600)).toBe('10 min')
  })

  it('spells out repetitions, pace and recovery', () => {
    expect(formatStep(reps(5, { distanceM: km(1) }, 'vo2', jogFor(90)))).toBe(
      '5 × 1 km @ 3:30–3:40/km · 90 s de trote',
    )
    expect(formatStep(reps(8, { durationS: 60 }, 'threshold', { kind: 'float', distanceM: null, durationS: 60 }))).toBe(
      '8 × 60 s @ 3:50–3:58/km · 60 s de trote suave',
    )
    expect(formatStep(strides(6))).toBe('6 progresiones de 20 s')
    expect(formatStep(warmup(km(2)))).toBe('2 km de calentamiento')
  })

  it('drops the recovery from a set of one — there is nothing to recover between', () => {
    expect(formatStep(reps(1, { distanceM: km(3) }, 'race', jogFor(90)))).toBe('3 km @ 3:45–3:47/km')
  })

  it('reads a whole session as one line', () => {
    expect(
      formatWorkout([warmup(km(2.5)), reps(3, { durationS: 480 }, 'threshold', jogFor(90)), cooldown(km(2))]),
    ).toBe(
      '2,5 km de calentamiento · 3 × 8 min @ 3:50–3:58/km · 90 s de trote · 2 km de vuelta a la calma',
    )
  })
})
