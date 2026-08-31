import { describe, expect, it } from 'vitest'
import { PACES } from '@/lib/paces'
import {
  STRENGTH_STRATEGY,
  formatExercise,
  strengthSummary,
  type StrengthExercise,
} from '@/lib/strength'

const exercise = (overrides: Partial<StrengthExercise> = {}): StrengthExercise => ({
  exerciseId: null,
  name: 'Sentadilla búlgara',
  sets: 3,
  reps: 8,
  durationS: null,
  perSide: false,
  restS: null,
  load: null,
  note: null,
  ...overrides,
})

describe('formatExercise', () => {
  it('says the series, and says the rest even when there is none', () => {
    expect(formatExercise(exercise())).toBe('3 × 8 · seguido')
  })

  it('marks a unilateral move per side', () => {
    expect(formatExercise(exercise({ perSide: true }))).toBe('3 × 8 por lado · seguido')
  })

  it('measures a hold in seconds instead of repetitions', () => {
    expect(formatExercise(exercise({ name: 'Plancha', reps: null, durationS: 40 }))).toBe(
      '3 × 40 s · seguido',
    )
  })

  it('reads a rest of two minutes or more the way a runner says it', () => {
    expect(formatExercise(exercise({ restS: 30 }))).toBe('3 × 8 · 30 s descanso')
    expect(formatExercise(exercise({ restS: 120 }))).toBe('3 × 8 · 2 min descanso')
  })

  it('treats an explicit zero rest as no rest at all', () => {
    // «sin descanso» and «descanso sin anotar» are the same instruction on a mat, and a
    // «0 s descanso» would read as a number somebody meant to fill in.
    expect(formatExercise(exercise({ restS: 0 }))).toContain('seguido')
  })

  it('appends the load last, as prose', () => {
    expect(formatExercise(exercise({ perSide: true, restS: 60, load: 'mancuerna 8 kg' }))).toBe(
      '3 × 8 por lado · 60 s descanso · mancuerna 8 kg',
    )
  })
})

describe('strengthSummary', () => {
  it('counts the moves, in singular and plural', () => {
    expect(strengthSummary([exercise()])).toBe('1 ejercicio')
    expect(strengthSummary([exercise(), exercise()])).toBe('2 ejercicios')
  })

  it('adds the stated duration as an estimate when there is one', () => {
    expect(strengthSummary([exercise(), exercise()], 2100)).toBe('2 ejercicios · ≈ 35 min')
  })

  it('says nothing about duration when the session states none', () => {
    expect(strengthSummary([exercise()], null)).toBe('1 ejercicio')
  })
})

describe('STRENGTH_STRATEGY', () => {
  const prescription = {
    kind: 'strength' as const,
    exercises: [exercise({ name: 'Plancha', reps: null, durationS: 40 })],
  }

  it('puts the name in front of the numbers, one line per move', () => {
    expect(STRENGTH_STRATEGY.lines(prescription, PACES)).toEqual(['Plancha · 3 × 40 s · seguido'])
  })

  it('expands as soon as there is a single move to list', () => {
    expect(STRENGTH_STRATEGY.expands(prescription)).toBe(true)
    expect(STRENGTH_STRATEGY.expands({ kind: 'strength', exercises: [] })).toBe(false)
  })

  it('derives nothing — a strength day is measured by the column, never by the payload', () => {
    // The counterpart of the run strategy's targetDistanceM: there is no honest distance
    // to compute here, and inventing a duration would fight the one the session states.
    expect(STRENGTH_STRATEGY.deriveTargets(prescription, PACES, true)).toEqual({})
    expect(STRENGTH_STRATEGY.deriveTargets(prescription, PACES, false)).toEqual({})
  })

  it('declares the family the matcher already gives strength sessions', () => {
    expect(STRENGTH_STRATEGY.family).toBe('strength')
  })
})

describe('an exercise measured in neither', () => {
  it('degrades to the series count rather than to a number with nothing after it', () => {
    // The validator forbids it; this is what a row that got past it anyway looks like.
    expect(formatExercise(exercise({ reps: null, durationS: null }))).toBe('3 series · seguido')
  })
})
