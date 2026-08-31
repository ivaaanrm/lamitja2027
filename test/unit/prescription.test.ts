import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOCK } from '@/lib/block'
import { PACES } from '@/lib/paces'
import { sessionInputs } from '@/lib/plan-input'
import { PRESCRIPTION_KINDS, SESSION_TYPES, type SportFamily } from '@/lib/session-types'
import { SESSION_META, sessionEffort } from '@/lib/plan'
import {
  STRATEGIES,
  formatPrescription,
  prescriptionOf,
  runSteps,
  type Prescription,
  type PrescriptionKind,
  type PrescriptionStrategy,
  type StoredPrescription,
} from '@/lib/prescription'
import type { StrengthPrescription } from '@/lib/strength'
import { cooldown, formatWorkout, jogFor, km, reps, warmup } from '@/lib/workout'
import type { PlanSession } from '@/lib/db/schema'

const STEPS = [warmup(2000), reps(5, { distanceM: km(1) }, 'vo2', jogFor(90)), cooldown(1500)]

const STRENGTH: StrengthPrescription = {
  kind: 'strength',
  exercises: [
    {
      exerciseId: 'bulgarian-split-squat',
      name: 'Sentadilla búlgara',
      sets: 3,
      reps: 8,
      durationS: null,
      perSide: true,
      restS: 60,
      load: 'mancuerna 8 kg',
      note: null,
    },
  ],
}

/** What D1 hands back: the column is JSON text, so every payload has been through a parse. */
const asStored = (value: unknown): StoredPrescription =>
  JSON.parse(JSON.stringify(value)) as StoredPrescription

describe('prescriptionOf', () => {
  it('reads a bare array as a run — the encoding every existing row is written in', () => {
    const p = prescriptionOf(asStored(STEPS))
    expect(p?.kind).toBe('run')
    expect(p).toEqual({ kind: 'run', steps: STEPS })
  })

  it('reads a tagged payload back as itself', () => {
    expect(prescriptionOf(asStored(STRENGTH))).toEqual(STRENGTH)
  })

  it('treats an empty array and a null column alike, as no prescription', () => {
    // `steps?.length` always said this; an empty array is what the editor leaves behind
    // when the last step is deleted, and it has never meant "a workout with nothing in it".
    expect(prescriptionOf([])).toBeNull()
    expect(prescriptionOf(null)).toBeNull()
    expect(prescriptionOf(undefined)).toBeNull()
  })
})

describe('runSteps', () => {
  it('narrows a legacy row to exactly the array it stored', () => {
    expect(runSteps(asStored(STEPS))).toEqual(STEPS)
  })

  it('refuses a tagged payload rather than measuring planks in kilometres', () => {
    expect(runSteps(asStored(STRENGTH))).toBeNull()
    expect(runSteps([])).toBeNull()
    expect(runSteps(null)).toBeNull()
  })
})

describe('legacy rows read unchanged', () => {
  const session = (steps: StoredPrescription | null): PlanSession => ({
    userId: 'owner',
    id: 's1',
    scheduledOn: 0,
    dayOrder: 0,
    type: 'interval',
    title: 'Series',
    notes: null,
    steps,
    targetDistanceM: null,
    targetDurationS: null,
    targetPaceLoSKm: null,
    targetPaceHiSKm: null,
    doneAt: null,
    activityId: null,
    updatedAt: 0,
  })

  it('derives the same zone, band and estimate from a pre-branch row', () => {
    const effort = sessionEffort(session(asStored(STEPS)))
    expect(effort.zone).toBe('vo2')
    expect(effort.band).toEqual(PACES.vo2)
    expect(effort.estimateS).toBeGreaterThan(0)
  })

  it('falls back to the session columns for a tagged payload, as a bare row does', () => {
    // Nothing about a list of exercises names a pace, so the strength session reads like
    // the duration-only sessions that have always had no steps at all.
    const tagged = sessionEffort(session(asStored(STRENGTH)))
    expect(tagged).toEqual(sessionEffort(session(null)))
  })
})

describe('the registry', () => {
  it('has one strategy per kind, and every kind names itself', () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual([...PRESCRIPTION_KINDS].sort())
    for (const kind of PRESCRIPTION_KINDS) expect(STRATEGIES[kind].kind).toBe(kind)
  })

  it('resolves every kind a session type can prescribe', () => {
    for (const type of SESSION_TYPES) {
      const kind = SESSION_META[type].prescribes
      if (kind == null) continue
      expect(STRATEGIES[kind]).toBeDefined()
    }
  })

  it('agrees with SESSION_META about which activities satisfy a kind', () => {
    // The strategy's `family` is descriptive — `matchDay` reads SESSION_META — so the only
    // thing keeping the two honest is this. A future kind that must never be matched to an
    // activity declares a family `sportFamily()` never returns, and needs no matcher edit.
    for (const type of SESSION_TYPES) {
      const kind = SESSION_META[type].prescribes
      if (kind == null) continue
      expect(STRATEGIES[kind].family).toBe(SESSION_META[type].family)
    }
  })

  it('offers every kind an authoring schema and a brief fragment for the agents', () => {
    for (const kind of PRESCRIPTION_KINDS) {
      expect(STRATEGIES[kind].authoring.schema).toBeTypeOf('object')
      expect(STRATEGIES[kind].authoring.brief).toBeTypeOf('object')
    }
  })
})

describe('formatPrescription', () => {
  it('says a run exactly as formatWorkout always did', () => {
    const p = prescriptionOf(asStored(STEPS))!
    expect(formatPrescription(p)).toBe(formatWorkout(STEPS))
  })

  it('joins a strength day the same way, one move per part', () => {
    expect(formatPrescription(STRENGTH)).toBe(
      'Sentadilla búlgara · 3 × 8 por lado · 60 s descanso · mancuerna 8 kg',
    )
  })

  it('derives a distance for a run that counts as volume, and nothing for one that does not', () => {
    const p = prescriptionOf(asStored(STEPS))!
    expect(STRATEGIES.run.deriveTargets(p as never, PACES, true).targetDistanceM).toBeGreaterThan(0)
    expect(STRATEGIES.run.deriveTargets(p as never, PACES, false)).toEqual({})
  })
})

/**
 * The extension point, exercised rather than asserted.
 *
 * §9 of the plan claims a future kind — a nutrition day: never matched to an activity,
 * deriving nothing, ticked by hand or not at all — costs one module and one registry entry,
 * and touches no existing kind's code. This fabricates exactly that kind here and runs it
 * through the same three registry operations the app dispatches on.
 *
 * The fabricated entry is typed from the **real** `PrescriptionStrategy`, not from a copy
 * of it written out beside this test — which is what this block used to do, and what made
 * it a mock of the extension point rather than the extension point. Every member below is
 * an indexed access into the live declaration; only `kind` and the payload are widened,
 * because a kind that does not exist yet cannot be a `PrescriptionKind`, which is the whole
 * situation being modelled. A clone would have gone on compiling after somebody narrowed
 * `PrescriptionStrategy.family` to `'run' | 'strength'` or changed what `deriveTargets` is
 * allowed to return — the regressions that would actually make the registry un-extendable,
 * and the only ones this block exists to catch. (The other half of §9's mechanism, that
 * `STRATEGIES` demands an entry per kind, is pinned above by the keys test: a hand-written
 * object type would still have to list them, and would still be caught there.)
 */
describe('a future kind plugs in without touching the existing ones', () => {
  interface NutritionPrescription {
    kind: 'nutrition'
    carbsGKg: number
    meals: string[]
  }

  /** The real interface at its widest, to index off. */
  type Real = PrescriptionStrategy<PrescriptionKind>

  /**
   * `PrescriptionStrategy` with its kind and its payload widened and nothing else restated
   * — the payload sits in the position that lets one map hold strategies over different
   * shapes, exactly as `STRATEGIES` does.
   */
  interface FutureStrategy<P> {
    kind: string
    family: Real['family']
    expands(p: P): ReturnType<Real['expands']>
    lines(p: P, bands: Parameters<Real['lines']>[1]): ReturnType<Real['lines']>
    deriveTargets(
      p: P,
      bands: Parameters<Real['deriveTargets']>[1],
      countsAsVolume: Parameters<Real['deriveTargets']>[2],
    ): ReturnType<Real['deriveTargets']>
    authoring: Real['authoring']
  }

  const NUTRITION_STRATEGY = {
    kind: 'nutrition',
    // A real one appends its own family to `SportFamily` in the leaf (§9 step 1) so that
    // `sportFamily()` can never return it and pass 2 of `matchDay` can never hold. A test
    // cannot widen that union, so this borrows an existing member — which is the stricter
    // reading anyway: `family` has to be a `SportFamily`, and the cast that used to sit
    // here meant the type this field is declared as was never actually being tested.
    family: 'other',
    expands: (p: NutritionPrescription) => p.meals.length > 0,
    lines: (p: NutritionPrescription) => [`${p.carbsGKg} g/kg`, ...p.meals],
    deriveTargets: () => ({}),
    authoring: { schema: { type: 'object' }, brief: { fields: ['carbsGKg', 'meals'] } },
  } satisfies FutureStrategy<NutritionPrescription>

  const EXTENDED: Record<string, FutureStrategy<never>> = {
    ...(STRATEGIES as Record<PrescriptionKind, FutureStrategy<never>>),
    nutrition: NUTRITION_STRATEGY,
  }

  /** `formatPrescription`, generic over whatever the registry holds. */
  const oneLine = (p: { kind: string }) => EXTENDED[p.kind]!.lines(p as never, PACES).join(' · ')

  const DAY: NutritionPrescription = { kind: 'nutrition', carbsGKg: 6, meals: ['Avena', 'Arroz'] }

  it('is reachable through the same lookup as run and strength', () => {
    expect(oneLine(DAY)).toBe('6 g/kg · Avena · Arroz')
    expect(oneLine(prescriptionOf(asStored(STEPS)) as Prescription)).toBe(formatWorkout(STEPS))
    expect(oneLine(STRENGTH)).toBe(formatPrescription(STRENGTH))
  })

  it('needs no matcher, no migration and no derived column of its own', () => {
    expect(EXTENDED.nutrition!.deriveTargets(DAY as never, PACES, true)).toEqual({})
    // `matchDay` reads `SESSION_META[type].family`, never a strategy's, so a kind arrives
    // with no way of being matched at all until §9 step 4 gives it a session type — and
    // the matcher is untouched either way. What the strategy declares is a `SportFamily`,
    // and here it is one.
    expect(SESSION_TYPES.some((t) => (SESSION_META[t].prescribes as string) === 'nutrition')).toBe(
      false,
    )
    const families: SportFamily[] = ['run', 'strength', 'other']
    expect(families).toContain(EXTENDED.nutrition!.family)
  })

  it('leaves the existing kinds answering exactly what they answered before', () => {
    expect(EXTENDED.run).toBe(STRATEGIES.run)
    expect(EXTENDED.strength).toBe(STRATEGIES.strength)
    expect(EXTENDED.run!.expands(prescriptionOf(asStored(STEPS)) as never)).toBe(true)
  })
})

/**
 * The wire, from the editor and from an agent alike.
 *
 * The one thing worth a test here is the error, not the value: the column now holds two
 * shapes, and the obvious `z.union` of the two answered a mistyped step with a single
 * issue at `steps` — which is the field, not the mistake. `api.ts` renders `issue.path`
 * beside the input, so that regression is invisible until somebody is typing into the plan
 * editor with nothing to read.
 */
describe('the validator accepts both shapes and blames the right field', () => {
  const { createSessionInput } = sessionInputs(DEFAULT_BLOCK)
  const base = { scheduledOn: DEFAULT_BLOCK.startsOn, title: 'Sesión' }
  const step = {
    kind: 'rep',
    reps: 5,
    distanceM: 1000,
    durationS: null,
    zone: 'vo2',
    recovery: null,
    note: null,
  }

  it('takes a bare step array exactly as it always did', () => {
    const parsed = createSessionInput.safeParse({ ...base, type: 'interval', steps: [step] })
    expect(parsed.success && parsed.data.steps).toEqual([step])
  })

  it('names the offending index and field inside a step array', () => {
    const parsed = createSessionInput.safeParse({
      ...base,
      type: 'interval',
      steps: [step, { ...step, kind: 'sprint' }],
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toEqual(['steps.1.kind'])
  })

  it('takes a tagged strength payload and fills its blanks', () => {
    const parsed = createSessionInput.safeParse({
      ...base,
      type: 'strength',
      steps: { kind: 'strength', exercises: [{ name: 'Plancha', sets: 3, durationS: 40 }] },
    })
    expect(parsed.success && parsed.data.steps).toEqual({
      kind: 'strength',
      exercises: [
        {
          exerciseId: null,
          name: 'Plancha',
          sets: 3,
          reps: null,
          durationS: 40,
          perSide: false,
          restS: null,
          load: null,
          note: null,
        },
      ],
    })
  })

  it('refuses an exercise measured in both repetitions and seconds, by index', () => {
    const parsed = createSessionInput.safeParse({
      ...base,
      type: 'strength',
      steps: { kind: 'strength', exercises: [{ name: 'Plancha', sets: 3, reps: 8, durationS: 40 }] },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path.join('.')).toBe('steps.exercises.0')
    expect(parsed.error?.issues[0]?.message).toContain('repeticiones o segundos')
  })

  it('refuses an exercise measured in neither', () => {
    const parsed = createSessionInput.safeParse({
      ...base,
      type: 'strength',
      steps: { kind: 'strength', exercises: [{ name: 'Plancha', sets: 3 }] },
    })
    expect(parsed.success).toBe(false)
  })

  it('still takes null, which is what clears a breakdown', () => {
    const parsed = createSessionInput.safeParse({ ...base, type: 'easy', steps: null })
    expect(parsed.success && parsed.data.steps).toBeNull()
  })

  it('blames the tag when the payload is an object of no known kind', () => {
    const parsed = createSessionInput.safeParse({ ...base, type: 'strength', steps: { foo: 1 } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path.join('.')).toBe('steps.kind')
  })
})
