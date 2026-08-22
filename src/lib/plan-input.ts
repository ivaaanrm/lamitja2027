import { z } from 'zod'
import { BLOCK_START, TOTAL_WEEKS, WEEK_MS, startOfDay } from './block'
import { PACE_ZONES } from './paces'
import { SESSION_TYPES } from './plan'
import { RECOVERY_KINDS, STEP_KINDS, type Step } from './workout'

/**
 * Validation for every plan write. Kept apart from `plan.ts` because that module ships to
 * the browser and this one only ever runs in the Worker — the editor posts, the server
 * decides.
 */
/** Half-open: the block's last day is race day itself. */
const inBlock = (at: number) => at >= BLOCK_START && at < BLOCK_START + TOTAL_WEEKS * WEEK_MS

const scheduledOn = z
  .number()
  .int()
  .transform(startOfDay)
  .refine(inBlock, 'La fecha cae fuera del bloque')

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

const sessionFields = {
  scheduledOn,
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

/** A new session needs a day, a type and a name; everything else has a sensible blank. */
export const createSessionInput = z.object({
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
export const updateSessionInput = z
  .object(sessionFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'No hay nada que actualizar')

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

/** `z.input`, not `z.infer` — these describe what the editor sends, before defaults land. */
export type CreateSessionInput = z.input<typeof createSessionInput>
export type UpdateSessionInput = z.input<typeof updateSessionInput>
export type UpdateWeekInput = z.input<typeof updateWeekInput>
