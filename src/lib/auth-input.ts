import { z } from 'zod'
import { MAX_BLOCK_WEEKS, MIN_BLOCK_WEEKS, WEEK_MS, startOfDay, startOfWeek } from './block'

/**
 * Validation for every auth, profile and plan-generation write. Kept apart from the
 * modules it guards for the same reason `plan-input.ts` is: zod runs in the Worker only,
 * and `block.ts` ships to the browser.
 *
 * The client posts, the server decides — an island's own checks are there to spare a
 * round trip, never to be the rule.
 */

/** Normalised before it is validated: a pasted address arrives with whitespace on it. */
const email = z
  .string()
  .max(200)
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email('Correo no válido'))

/** 10 is the floor because nothing else stands between an invite link and the data. */
const password = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(200, 'La contraseña es demasiado larga')

/** Login takes any non-empty string: the rule is enforced where a password is *set*, and
 * bouncing a short one here would only tell an attacker which rule the account predates. */
const candidatePassword = z.string().min(1).max(200)

const displayName = z.string().trim().min(1, 'Falta el nombre').max(80)

/** 0 = Monday, matching `weekDays` and the plan's day order. */
const weekday = z.number().int().min(0).max(6)

const raceDistanceM = z.number().min(1000).max(100_000)

const blockConfig = z
  .object({
    /**
     * Snapped to a Monday: every week index is `(at - startsOn) / WEEK_MS`, so a start on
     * any other weekday would put every week boundary of the block mid-week.
     */
    startsOn: z.number().int().transform(startOfWeek),
    raceOn: z.number().int().transform(startOfDay),
    goalTimeS: z.number().int().min(600).max(21_600),
    raceDistanceM,
    raceName: z.string().trim().min(1, 'Falta el nombre de la carrera').max(60),
  })
  .refine(
    ({ startsOn, raceOn }) => {
      const weeks = Math.ceil((raceOn - startsOn) / WEEK_MS)
      return weeks >= MIN_BLOCK_WEEKS && weeks <= MAX_BLOCK_WEEKS
    },
    `El bloque debe durar entre ${MIN_BLOCK_WEEKS} y ${MAX_BLOCK_WEEKS} semanas`,
  )

export const loginInput = z.object({ email, password: candidatePassword })

export const registerInput = z.object({
  token: z.string().trim().min(1, 'Falta la invitación').max(200),
  email,
  password,
  displayName,
})

/** `password` here is `APP_PASSWORD`, the bootstrap secret; `newPassword` is the account's. */
export const bootstrapInput = z.object({
  password: candidatePassword,
  email,
  newPassword: password,
  displayName,
})

export const profileInput = z
  .object({ displayName, hrMax: z.number().int().min(120).max(230).nullable(), block: blockConfig })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'No hay nada que actualizar')

export const inviteInput = z.object({
  note: z.string().trim().max(120).nullable().default(null),
})

/**
 * The wizard's answers. Shape and ranges only — whether the long run falls on a run day,
 * or two quality days sit back to back, is `validatePlanInput`'s to say, because those
 * are the answers the wizard renders in prose next to the field that caused them.
 */
