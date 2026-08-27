import { z } from 'zod'
import { WEEK_MS, startOfDay, totalWeeks, type BlockConfig } from './block'
import { PACE_ZONES } from './paces'
import { SESSION_TYPES } from './plan'
import { RECOVERY_KINDS, STEP_KINDS, type Step } from './workout'

/**
 * Validation for every plan write. Kept apart from `plan.ts` because that module ships to
 * the browser and this one only ever runs in the Worker — the editor posts, the server
 * decides.
 *
 * The session schemas are built per athlete rather than declared once: "the date falls
 * outside the block" is the whole point of `scheduledOn`, and whose block it is is not
 * something a module-level constant can know any more.
 */

/** Metres and seconds, matching how everything else is stored. */
const positive = z.number().positive().nullable()

/**
 * The structured workout, mirroring `Step` in `workout.ts`. Two declarations of one
 * shape, which is the price of keeping zod out of the browser bundle — `workout.ts`
 * ships to the client and this file never leaves the Worker. The assignment below is
 * what keeps them honest: a field added to `Step` and forgotten here stops the build.
 */
const recoveryInput = z
  .object({
    kind: z.enum(RECOVERY_KINDS),
    distanceM: positive,
    durationS: z.number().int().positive().nullable(),
  })
  .nullable()

const stepInput = z.object({
  kind: z.enum(STEP_KINDS),
  reps: z.number().int().min(1).max(60),
  distanceM: positive,
  durationS: z.number().int().positive().nullable(),
  zone: z.enum(PACE_ZONES).nullable(),
  recovery: recoveryInput,
  note: z.string().trim().max(300).nullable(),
})

const steps = z.array(stepInput).max(24).nullable()

// Compile-time proof that the validator and the model describe the same thing.
type _StepsMatch = z.infer<typeof stepInput> extends Step ? true : never
const _stepsMatch: _StepsMatch = true as const
void _stepsMatch

/** Everything a session carries that does not depend on which block it belongs to. */
const commonFields = {
  dayOrder: z.number().int().min(0).max(9),
  type: z.enum(SESSION_TYPES),
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable(),
  steps,
  targetDistanceM: positive,
  targetDurationS: z.number().int().positive().nullable(),
  targetPaceLoSKm: positive,
  targetPaceHiSKm: positive,
  doneAt: z.number().int().nullable(),
  activityId: z.number().int().nullable(),
}

/**
 * The two session schemas for one athlete's block.
 *
 * A factory rather than a pair of constants because the only block-dependent rule —
 * `scheduledOn` has to land inside the block — needs the athlete's own dates. Build it
 * once per request from `context.locals.user`'s block; it is a handful of object
 * literals, not something worth caching.
 */
export function sessionInputs(block: BlockConfig) {
  /** Half-open: the block's last day is race day itself. */
  const inBlock = (at: number) =>
    at >= block.startsOn && at < block.startsOn + totalWeeks(block) * WEEK_MS

  const sessionFields = {
    ...commonFields,
    scheduledOn: z
      .number()
      .int()
      .transform(startOfDay)
      .refine(inBlock, 'La fecha cae fuera del bloque'),
  }

  /** A new session needs a day, a type and a name; everything else has a sensible blank. */
  const createSessionInput = z.object({
    ...sessionFields,
    dayOrder: sessionFields.dayOrder.default(0),
    notes: sessionFields.notes.default(null),
    steps: sessionFields.steps.default(null),
    targetDistanceM: sessionFields.targetDistanceM.default(null),
    targetDurationS: sessionFields.targetDurationS.default(null),
    targetPaceLoSKm: sessionFields.targetPaceLoSKm.default(null),
    targetPaceHiSKm: sessionFields.targetPaceHiSKm.default(null),
    doneAt: sessionFields.doneAt.default(null),
    activityId: sessionFields.activityId.default(null),
  })

  /** Every field optional — an absent key means "leave it alone", `null` means "clear it". */
  const updateSessionInput = z
    .object(sessionFields)
    .partial()
    .refine((patch) => Object.keys(patch).length > 0, 'No hay nada que actualizar')

  return { createSessionInput, updateSessionInput }
}

/** A week carries no dates of its own — its Monday is derived — so it needs no block. */
export const updateWeekInput = z
  .object({
    phase: z.string().trim().max(60).nullable(),
    focus: z.string().trim().max(200).nullable(),
    targetVolumeM: z.number().positive().nullable(),
    isDownWeek: z.boolean(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'No hay nada que actualizar')

export type SessionInputs = ReturnType<typeof sessionInputs>

/** `z.input`, not `z.infer` — these describe what the editor sends, before defaults land. */
export type CreateSessionInput = z.input<SessionInputs['createSessionInput']>
export type UpdateSessionInput = z.input<SessionInputs['updateSessionInput']>
export type UpdateWeekInput = z.input<typeof updateWeekInput>
