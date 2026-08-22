import { z } from 'zod'
import { BLOCK_START, TOTAL_WEEKS, WEEK_MS, startOfDay } from './block'
import { SESSION_TYPES } from './plan'

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
  .refine(inBlock, 'Date falls outside the 22-week block')

/** Metres and seconds, matching how everything else is stored. */
const positive = z.number().positive().nullable()

const sessionFields = {
  scheduledOn,
  dayOrder: z.number().int().min(0).max(9),
  type: z.enum(SESSION_TYPES),
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable(),
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
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update')

export const updateWeekInput = z
  .object({
    phase: z.string().trim().max(60).nullable(),
    focus: z.string().trim().max(200).nullable(),
    targetVolumeM: z.number().positive().nullable(),
    isDownWeek: z.boolean(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update')

/** `z.input`, not `z.infer` — these describe what the editor sends, before defaults land. */
export type CreateSessionInput = z.input<typeof createSessionInput>
export type UpdateSessionInput = z.input<typeof updateSessionInput>
export type UpdateWeekInput = z.input<typeof updateWeekInput>
