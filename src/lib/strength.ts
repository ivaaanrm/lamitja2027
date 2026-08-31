import { formatSeconds } from './workout'
import type { PrescriptionStrategy } from './prescription'

/**
 * The other kind of prescription: a Fuerza day, as data rather than prose.
 *
 * `workout.ts` made the same argument for running — "5 × 1 km @ 3:50" in `notes` reads
 * fine and computes nothing — and a strength day is the case where the prose is worse
 * still, because the thing an athlete actually needs on a mat is the *list*: nine moves,
 * ticked off one at a time, each with its own illustration. A paragraph cannot be read
 * that way, and it cannot be reused: the same nine moves are prescribed every Monday for
 * eleven weeks, which is what `workout_templates` is for.
 *
 * Pure and browser-safe, the same charter as `workout.ts` — no drizzle, no zod, no clock.
 * It knows nothing about the exercise catalogue either: an entry carries the Spanish name
 * it was prescribed under, so a row still renders when the catalogue is not to hand. The
 * catalogue *enriches* on read (the illustration, the instructions); it is never what makes
 * the prescription legible.
 */

/** One prescribed exercise — the unit both a template row and a strength session carry. */
export interface StrengthExercise {
  /**
   * RepDB catalogue id — resolves the illustration and the instructions on read — or null
   * for a move the catalogue does not have. A written-in exercise is not an error: the
   * catalogue is somebody else's vocabulary, and «almejas con banda» as the physio said it
   * outranks whatever it happens to be filed under.
   */
  exerciseId: string | null
  /**
   * The name as prescribed, Spanish. Always present, and free to differ from the
   * catalogue's — «Almejas (banda media)» names the load in the same breath.
   */
  name: string
  sets: number
  /** Repetitions per set… */
  reps: number | null
  /** …or seconds held. Exactly one of the two is set — a plank has no repetitions. */
  durationS: number | null
  /** Per side, for unilateral moves — renders as «3 × 8 por lado». */
  perSide: boolean
  /** Rest between sets, seconds. `null` (or 0) renders as «seguido». */
  restS: number | null
  /**
   * Free text — «sin peso», «mancuerna 8 kg», «minibanda media». Prose on purpose, and
   * this is the one place in the app where that is the honest shape: kilograms describe a
   * dumbbell and nothing else, bands come in colours, and bodyweight has no number at all.
   * A `loadKg` column would be null on two thirds of the rows it was added for.
   */
  load: string | null
  note: string | null
}

/** The tagged payload `plan_sessions.steps` stores for a Fuerza day. */
export interface StrengthPrescription {
  kind: 'strength'
  exercises: StrengthExercise[]
}

/** `3 × 8`, `3 × 40 s` — how much of the move, before anything is said about the rest. */
const amount = (e: StrengthExercise): string =>
  e.reps != null
    ? `${e.sets} × ${e.reps}`
    : e.durationS != null
      ? `${e.sets} × ${formatSeconds(e.durationS)}`
      : // The validator forbids neither-nor. This is what a row that got past it anyway
        // degrades to, rather than «3 × », which reads as a number somebody lost.
        `${e.sets} series`

/**
 * `3 × 8 por lado · 60 s descanso · minibanda` — the numbers without the name.
 *
 * The rest is always said, either as a number or as «seguido», because "no descanso
 * escrito" and "sin descanso" are different instructions on a mat and a blank cannot tell
 * them apart. The name is the caller's to put in front: a card shows it in its own weight,
 * and a one-liner joins the two with the same ` · ` everything else here uses.
 */
export function formatExercise(e: StrengthExercise): string {
  const size = e.perSide ? `${amount(e)} por lado` : amount(e)
  const rest = e.restS ? `${formatSeconds(e.restS)} descanso` : 'seguido'
  return [size, rest, e.load].filter(Boolean).join(' · ')
}

/** `9 ejercicios`, `9 ejercicios · ≈ 35 min` — the list-row caption. */
export function strengthSummary(
  exercises: StrengthExercise[],
  durationS?: number | null,
): string {
  const count = `${exercises.length} ${exercises.length === 1 ? 'ejercicio' : 'ejercicios'}`
  return durationS ? `${count} · ≈ ${formatSeconds(durationS)}` : count
}

/**
 * The agent-facing arm of `steps`. English, hand-written and deliberately wordy: it is the
 * whole documentation an agent gets for the shape, and every sentence in it is answering a
 * question that was otherwise going to be answered by guessing.
 */
const STRENGTH_ARM = {
  type: 'object',
  required: ['kind', 'exercises'],
  description:
    'A strength or mobility prescription: the list of moves, in the order they are done. Use this shape instead of the step array whenever the session is not run — the athlete reads it as a checklist, one move at a time. Every name, load and note in it is read by the athlete, so write them in Spanish.',
  properties: {
    kind: {
      type: 'string',
      const: 'strength',
      description: 'Tags the payload. Without it the value reads as a run workout.',
    },
    exercises: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        required: ['name', 'sets'],
        properties: {
          exerciseId: {
            type: ['string', 'null'],
            maxLength: 64,
            description:
              'A catalogue id from search_exercises — it is what resolves the illustration and the instructions on the athlete\'s screen. null for a move the catalogue does not have, which is not an error: the prescription still renders from `name`.',
          },
          name: {
            type: 'string',
            maxLength: 120,
            description:
              'What the athlete reads, Spanish. Required even when exerciseId is set, so the row survives a re-vendored catalogue — and so a prescription can name its own load («Almejas (banda media)»).',
          },
          sets: { type: 'integer', minimum: 1, maximum: 10, description: 'How many series.' },
          reps: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 100,
            description: 'Repetitions per set. Set this or durationS, never both and never neither.',
          },
          durationS: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 3600,
            description: 'Seconds held or worked per set, for a plank or a carry. Set this or reps.',
          },
          perSide: {
            type: 'boolean',
            description: 'True for a unilateral move; it renders as «3 × 8 por lado». Defaults to false.',
          },
          restS: {
            type: ['integer', 'null'],
            minimum: 0,
            maximum: 600,
            description: 'Rest between sets, seconds. null or 0 renders as «seguido».',
          },
          load: {
            type: ['string', 'null'],
            maxLength: 60,
            description:
              'Free text, Spanish — «sin peso», «mancuerna 8 kg», «minibanda media». Prose and not a number because kilograms only describe dumbbells; bands come in colours and bodyweight has no number.',
          },
          note: {
            type: ['string', 'null'],
            maxLength: 300,
            description: 'Coaching prose for this move — tempo, what to feel, what to stop on. Spanish.',
          },
        },
      },
    },
  },
} as const

/**
 * The strategy for this kind, beside its model rather than in `prescription.ts` — so that
 * adding a kind is one new file plus one line in the registry, which is the whole claim the
 * union is making. The type comes back the other way as a *type-only* import, so the cycle
 * is erased and nothing loads twice at runtime.
 */
export const STRENGTH_STRATEGY: PrescriptionStrategy<'strength'> = {
  kind: 'strength',
  family: 'strength',
  expands: (p) => p.exercises.length > 0,
  lines: (p) => p.exercises.map((e) => `${e.name} · ${formatExercise(e)}`),
  /** Never derived: a strength day is measured in minutes, and the session row states them. */
  deriveTargets: () => ({}),
  authoring: {
    schema: STRENGTH_ARM,
    brief: {
      shape: '{ kind: "strength", exercises: [...] }',
      fields: [
        'exerciseId',
        'name',
        'sets',
        'reps',
        'durationS',
        'perSide',
        'restS',
        'load',
        'note',
      ],
      rules: [
        'Exactly one of reps and durationS per exercise.',
        'name is required and is read by the athlete: Spanish.',
        'Nothing is derived from this payload — state targetDurationS on the session itself.',
      ],
    },
  },
}
