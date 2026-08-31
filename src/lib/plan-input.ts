import { z } from 'zod'
import { WEEK_MS, startOfDay, totalWeeks, type BlockConfig } from './block'
import { PACE_ZONES } from './paces'
import { SESSION_TYPES } from './plan'
import { RECOVERY_KINDS, STEP_KINDS, type Step } from './workout'
import type { StrengthExercise } from './strength'
import type { StoredPrescription } from './prescription'

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

/**
 * The other arm of the prescription, mirroring `StrengthExercise` in `strength.ts` for the
 * same reason and at the same cost: that module ships to the browser, this one never
 * leaves the Worker, and the assignments below are what stop the two drifting.
 *
 * The one rule the types cannot state is the `refine`: an exercise is measured in
 * repetitions *or* in seconds, and a payload carrying both is two prescriptions arguing.
 */
const strengthExerciseInput = z
  .object({
    exerciseId: z.string().trim().min(1).max(64).nullable().default(null),
    name: z.string().trim().min(1).max(120),
    sets: z.number().int().min(1).max(10),
    reps: z.number().int().min(1).max(100).nullable().default(null),
    durationS: z.number().int().min(1).max(3600).nullable().default(null),
    perSide: z.boolean().default(false),
    restS: z.number().int().min(0).max(600).nullable().default(null),
    load: z.string().trim().max(60).nullable().default(null),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .refine(
    (e) => (e.reps == null) !== (e.durationS == null),
    'Cada ejercicio lleva repeticiones o segundos, no ambos ni ninguno',
  )

const strengthPrescriptionInput = z.object({
  kind: z.literal('strength'),
  exercises: z.array(strengthExerciseInput).min(1).max(24),
})

/**
 * One entry per tagged kind — the zod half of the registry in `prescription.ts`. A kind
 * added there and forgotten here fails `_PrescriptionMatch` below: that assertion runs in
 * *both* directions on purpose, and the reverse one is the half that does the work. Read
 * forwards it only says this validator never accepts a shape the column cannot hold, which
 * a forgotten arm satisfies trivially — it accepts less. Read backwards it says the column
 * holds nothing this validator would refuse, so a kind in the model with no arm here is a
 * build error rather than a confusing 400 on a payload the app itself considers valid.
 */
const taggedPrescriptionInput = z.discriminatedUnion('kind', [strengthPrescriptionInput])

const stepArrayInput = z.array(stepInput).max(24)

/** What the editor and an agent may send, before either arm's defaults land. */
type StepsInput = z.input<typeof stepArrayInput> | z.input<typeof taggedPrescriptionInput>

/**
 * The column, historically named `steps` — it holds the prescription. The array arm is
 * unchanged, because a bare array *is* the run encoding and every row ever written is one.
 *
 * Branched by hand on `Array.isArray` rather than written as `z.union([…])`, and the
 * reason is the error, not the value. A union runs both arms and, when both fail, reports
 * one `invalid_union` issue at the path of the *field* with the arms' own issues buried in
 * a nested `errors` array — so `api.ts`'s `invalid()`, which maps `issue.path` to a field
 * name, turned `steps[1].kind is not a step kind` into `steps: Invalid input` and the plan
 * editor lost the one thing it renders. (zod does flatten a union whose losing arms all
 * *aborted*, which is why a bad strength payload reported cleanly and a bad step list did
 * not — a distinction no caller should have to know.) Branching first means the array
 * input is only ever measured against the array schema, so its issues come back at
 * `steps.1.kind` exactly as they did before this column held two shapes. The accepted
 * value is unchanged: same arms, same defaults, same output.
 */
const steps = z
  .custom<StepsInput>()
  .transform((value, ctx) => {
    const parsed = Array.isArray(value)
      ? stepArrayInput.safeParse(value)
      : taggedPrescriptionInput.safeParse(value)
    if (!parsed.success) {
      // The sub-parse's paths are relative to this field and `addIssue` prefixes it, so
      // `[1, 'kind']` comes back as `steps.1.kind`. It is retagged `custom` because that
      // is the only code `addIssue` is typed for; nothing downstream reads a code —
      // `api.ts` and the MCP session parser both reduce an issue to path and message.
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' })
      return z.NEVER
    }
    return parsed.data
  })
  .nullable()

// Compile-time proof that the validator and the model describe the same thing.
type _StepsMatch = z.infer<typeof stepInput> extends Step ? true : never
const _stepsMatch: _StepsMatch = true as const
void _stepsMatch

// Both directions, because a field this schema accepts and the model has no room for is
// as much a drift as one the model has and this forgets.
type _StrengthMatch =
  z.infer<typeof strengthExerciseInput> extends StrengthExercise
    ? StrengthExercise extends z.infer<typeof strengthExerciseInput>
      ? true
      : never
    : never
const _strengthMatch: _StrengthMatch = true as const
void _strengthMatch

// And that what the validator lets through is exactly what the column is typed to hold —
// both directions, for the reason spelled out over `taggedPrescriptionInput`: the forward
// one is satisfied by a validator that accepts too little, and accepting too little is
// precisely what a forgotten arm looks like.
type _PrescriptionMatch =
  NonNullable<z.infer<typeof steps>> extends StoredPrescription
    ? StoredPrescription extends NonNullable<z.infer<typeof steps>>
      ? true
      : never
    : never
const _prescriptionMatch: _PrescriptionMatch = true as const
void _prescriptionMatch

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

/**
 * A reusable strength template. Block-independent — a template carries no date, which is
 * the whole reason it is not a session — so it is declared once, like `updateWeekInput`,
 * rather than built per athlete.
 */
export const createTemplateInput = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable().default(null),
  exercises: z.array(strengthExerciseInput).min(1).max(24),
  targetDurationS: z.number().int().positive().nullable().default(null),
})

/**
 * Every field optional — absent means "leave it alone", `null` means "clear it". A patch
 * carrying `exercises` replaces the whole list: an entry has no identity of its own, so
 * there is nothing for a partial update to address.
 */
export const updateTemplateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    notes: z.string().trim().max(2000).nullable(),
    exercises: z.array(strengthExerciseInput).min(1).max(24),
    targetDurationS: z.number().int().positive().nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'No hay nada que actualizar')

export type SessionInputs = ReturnType<typeof sessionInputs>

/** `z.input`, not `z.infer` — these describe what the editor sends, before defaults land. */
export type CreateSessionInput = z.input<SessionInputs['createSessionInput']>
export type UpdateSessionInput = z.input<SessionInputs['updateSessionInput']>
export type UpdateWeekInput = z.input<typeof updateWeekInput>
export type CreateTemplateInput = z.input<typeof createTemplateInput>
export type UpdateTemplateInput = z.input<typeof updateTemplateInput>
