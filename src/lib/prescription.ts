import { PACES, PACE_ZONES } from './paces'
import {
  RECOVERY_KINDS,
  STEP_KINDS,
  formatStep,
  workoutDistanceM,
  type Bands,
  type Step,
} from './workout'
import { STRENGTH_STRATEGY, type StrengthPrescription } from './strength'
import type { PrescriptionKindName, SportFamily } from './session-types'

/**
 * What a session prescribes, as one discriminated union with one registry behind it.
 *
 * `plan_sessions.steps` used to be exactly one thing — an array of running steps — and the
 * column is still called that, because renaming it would rewrite every row for a word.
 * What changed is that a Fuerza day has a prescription too, and it is not a list of reps at
 * a pace: it is a list of moves, each with its own series, its own load and its own
 * illustration. The wrong fix is a second column per kind, which is a migration per kind
 * and a `case` in every reader. The fix here is a tagged payload in the one column, and a
 * *strategy* per kind holding everything that differs — so the readers dispatch on the tag
 * and know nothing else about it.
 *
 * The discriminant rule, which is the only thing about this file worth memorising: **a bare
 * JSON array IS the run encoding.** Every row that exists today is `Step[]` or NULL, and
 * `Array.isArray` classifies all of them — so there is no migration, no backfill and no
 * dual-read window, and a service worker still holding last week's bundle meets a tagged
 * payload, reads `steps?.length` as `undefined` and renders no breakdown. It degrades; it
 * never breaks. New run sessions keep storing the bare array: the `run` tag exists in
 * memory only, which is what keeps the two statements above true forever.
 *
 * There are exactly two readers of the column — `prescriptionOf`, which canonicalises it,
 * and `runSteps`, which narrows to running steps for the code that genuinely only means
 * running. Nothing else may test the shape by hand.
 *
 * Pure and browser-safe: no drizzle, no zod, no clock. The zod mirror lives in
 * `plan-input.ts`, which only the Worker loads, and a type-level assignment there fails the
 * build if the two ever drift apart.
 */

/** The canonical, in-memory shape of a running prescription. Never stored with its tag. */
export interface RunPrescription {
  kind: 'run'
  steps: Step[]
}

/**
 * The kinds, as a map. Adding one is an entry here and an entry in `STRATEGIES` — and the
 * mapped `Record` below is what turns "and an entry in" into a build error rather than a
 * runtime hole.
 */
export interface Prescriptions {
  run: RunPrescription
  strength: StrengthPrescription
}

export type PrescriptionKind = keyof Prescriptions
export type Prescription = Prescriptions[PrescriptionKind]

/** Every kind but `run` — the ones that are stored with their tag on. */
export type TaggedPrescription = Exclude<Prescription, RunPrescription>

/** What the `steps` column actually holds. A bare array is the run encoding. */
export type StoredPrescription = Step[] | TaggedPrescription

// The leaf's string list and this interface's keys are the same set, in both directions —
// a kind added to one and forgotten in the other is a build error, not a missing screen.
type _KindsMatch =
  PrescriptionKindName extends PrescriptionKind
    ? PrescriptionKind extends PrescriptionKindName
      ? true
      : never
    : never
const _kindsMatch: _KindsMatch = true as const
void _kindsMatch

/**
 * Canonicalise the column into something with a tag on it.
 *
 * `[]` reads as no prescription, exactly as `steps?.length` always did: an empty array is
 * what an editor leaves behind when the last step is deleted, and it has never meant
 * "a workout with nothing in it".
 */
export const prescriptionOf = (
  stored: StoredPrescription | null | undefined,
): Prescription | null =>
  stored == null
    ? null
    : Array.isArray(stored)
      ? stored.length
        ? { kind: 'run', steps: stored }
        : null
      : stored

/**
 * Narrow to running steps — the drop-in for the `session.steps?.length ? … : null` that
 * every caller used to write by hand. A tagged payload reads as no steps, which is right:
 * `workoutDistanceM` on a list of planks is not a smaller number, it is a wrong one.
 */
export const runSteps = (stored: StoredPrescription | null | undefined): Step[] | null =>
  Array.isArray(stored) && stored.length ? stored : null

/**
 * Everything one kind does differently, in one object.
 *
 * The alternative — a `switch` in the card, another in the detail view, another at the MCP
 * write boundary, another in the brief — is four places to forget, none of which the type
 * checker can see. `STRATEGIES` is a `Record` over the kind union, so the moment a kind is
 * added to `Prescriptions` the build lists exactly the surfaces still missing.
 */
export interface PrescriptionStrategy<K extends PrescriptionKind> {
  kind: K
  /**
   * Which activity family satisfies sessions carrying this kind. Descriptive rather than
   * load-bearing — `SESSION_META` is what `matchDay` actually reads — so a future kind that
   * must never be matched to a Strava activity simply declares a family `sportFamily()`
   * never returns, and the matcher needs no edit at all. A test pins the two in agreement.
   */
  family: SportFamily
  /** Whether the payload has a breakdown worth unfolding, for the card that can expand. */
  expands(p: Prescriptions[K]): boolean
  /** One Spanish line per unit — `join(' · ')` is the one-liner. */
  lines(p: Prescriptions[K], bands: Bands): string[]
  /**
   * What the payload writes into the session's derived columns at the write boundary.
   *
   * `countsAsVolume` is resolved by the caller from `SESSION_META[type]` rather than read
   * here, which is the one concession that keeps the module graph acyclic:
   * session-types → paces → workout → strength → prescription → plan.
   */
  deriveTargets(
    p: Prescriptions[K],
    bands: Bands,
    countsAsVolume: boolean,
  ): { targetDistanceM?: number | null; targetDurationS?: number | null }
  /**
   * English, for agents: the JSON-Schema arm of the MCP `steps` property, and the fragment
   * the block brief carries. It rides on the strategy — rather than sitting in `tools.ts`,
   * where it lived — because otherwise adding a kind means editing the MCP server, and the
   * whole claim of this design is that it does not. The cost is a couple of kilobytes of
   * English prose in the client bundle, which is the cheaper half of that trade.
   */
  authoring: { schema: Record<string, unknown>; brief: Record<string, unknown> }
}

/**
 * The recovery fragment of the run arm — moved out of `tools.ts` with the arm it belongs
 * to, unchanged word for word.
 */
const RECOVERY_ARM = {
  type: ['object', 'null'],
  description:
    'What happens between two repetitions, so a set of N reps has N−1 of them. Its distance is added to the week volume, which is why it is data and not a note. Omit for a step that does not repeat.',
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: [...RECOVERY_KINDS],
      description:
        '"jog" is the slow running between reps; "float" the easy running between fartlek surges; "walk" and "standing" are what they say.',
    },
    distanceM: { type: ['number', 'null'], description: 'Metres. Set this or durationS, not both.' },
    durationS: { type: ['integer', 'null'], description: 'Seconds. Set this or distanceM, not both.' },
  },
} as const

/**
 * The run arm of `steps` — today's `STEPS_SCHEMA`, word for word, minus the `'null'` in its
 * type list: the null now belongs to the union at the top, not to either arm inside it.
 */
const RUN_STEPS_ARM = {
  type: 'array',
  maxItems: 24,
  description:
    'The workout as data: warm-up, the effort, cool-down. This is what lets the app count repetitions, fold recovery jogs into the week volume and know the pace of a rep — never write the workout as prose in `notes`. Pass null to clear an existing breakdown. The session\'s distance and estimated duration are derived from these steps, so do not also set targetDistanceM when you set steps.',
  items: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: [...STEP_KINDS],
        description:
          '"warmup" / "cooldown" bracket the session; "rep" is a repeated effort; "steady" is a continuous block; "strides" is a count of short accelerations.',
      },
      reps: {
        type: 'integer',
        minimum: 1,
        maximum: 60,
        description: 'How many times the effort repeats. Defaults to 1.',
      },
      distanceM: { type: ['number', 'null'], description: 'Metres, per repetition. e.g. 1000 for 1 km reps.' },
      durationS: { type: ['integer', 'null'], description: 'Seconds, per repetition, for a step measured in time.' },
      zone: {
        type: ['string', 'null'],
        enum: [...PACE_ZONES, null],
        description:
          'Which pace band the effort is run at; see get_block.paceZones. null means "by feel", which is a deliberate prescription during a rebuild, not a missing value.',
      },
      recovery: RECOVERY_ARM,
      note: { type: ['string', 'null'], maxLength: 300, description: 'Coaching prose for this step. Spanish.' },
    },
  },
} as const

export const RUN_STRATEGY: PrescriptionStrategy<'run'> = {
  kind: 'run',
  family: 'run',
  /** `SessionCard`'s rule, verbatim: one step is a headline, two are a breakdown. */
  expands: (p) => p.steps.length > 1,
  lines: (p, bands) => p.steps.map((s) => formatStep(s, bands)),
  /**
   * The exact semantics `withDerivedDistance` shipped with: a type that does not count as
   * volume derives nothing, so a bare step array parked on a `strength` session stays
   * inert rather than quietly acquiring a running distance.
   */
  deriveTargets: (p, bands, countsAsVolume) =>
    countsAsVolume ? { targetDistanceM: workoutDistanceM(p.steps, bands) } : {},
  authoring: {
    schema: RUN_STEPS_ARM,
    brief: { stepKinds: [...STEP_KINDS], recoveryKinds: [...RECOVERY_KINDS] },
  },
}

/** One entry per kind. A kind added to `Prescriptions` and not to this is a build error. */
export const STRATEGIES: { [K in PrescriptionKind]: PrescriptionStrategy<K> } = {
  run: RUN_STRATEGY,
  strength: STRENGTH_STRATEGY,
}

/**
 * The session on one line, whatever its kind. Defaults to the owner's `PACES` for the same
 * reason `formatWorkout` does — a caller with no block to hand reads what it always did.
 */
export const formatPrescription = (p: Prescription, bands: Bands = PACES): string =>
  STRATEGIES[p.kind].lines(p as never, bands).join(' · ')
