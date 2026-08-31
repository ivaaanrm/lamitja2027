import { json } from './api'
import type { StrengthExercise } from './strength'
import { prescriptionOf, type StoredPrescription } from './prescription'

/**
 * The HTTP half of the one thing zod cannot check about a strength prescription: whether
 * the catalogue ids in it are real.
 *
 * `plan-input.ts` validates the *shape* — a name, a positive number of series, repetitions
 * or seconds but never both — and it is right not to know anything about the catalogue: it
 * would have to import 650 KB of vendored prose to reject a typo. So the id check lives at
 * the write boundaries instead, and there are exactly two of them. HTTP answers 400 with
 * Spanish field issues, which is what the editor renders next to the row that is wrong;
 * MCP throws an English `ToolError` carrying the same indexes, which is what an agent can
 * act on. Same question, two audiences, and neither one's prose leaks into the other's.
 *
 * The catalogue is deliberately **not** imported here. The routes call `unknownExerciseIds`
 * themselves and pass the answer in, so this module cannot become the bridge that carries
 * `src/lib/exercises/` into a client bundle — `test/unit/exercises.test.ts` scans direct
 * imports, and a module that both a route and a component could import is precisely the
 * shape that scan cannot see through. What is shared here is the sentence, which is the
 * part that would otherwise be typed four times and drift.
 */

/**
 * The refusal, or `null` when nothing was unknown.
 *
 * `pathPrefix` is what makes one function serve both callers: a template's entries live at
 * `exercises.3.exerciseId` and a session's at `steps.exercises.3.exerciseId`, and the path
 * is not decoration — `invalid()` and the editor both key on it to put the message beside
 * the input that produced it.
 *
 * An `exerciseId` of `null` never reaches here: a written-in move the catalogue does not
 * have is a legitimate prescription, and «almejas con banda» as the physio said it
 * outranks whatever RepDB files it under.
 */
export function unknownExercisesResponse(
  unknown: readonly { index: number; exerciseId: string }[],
  pathPrefix = 'exercises',
): Response | null {
  if (unknown.length === 0) return null

  return json(
    {
      error: 'Hay ejercicios que no están en el catálogo',
      issues: unknown.map(({ index, exerciseId }) => ({
        path: `${pathPrefix}.${index}.exerciseId`,
        message: `«${exerciseId}» no está en el catálogo de ejercicios`,
      })),
    },
    400,
  )
}

/**
 * The exercises a session write is prescribing, or `null` when it is not prescribing any.
 *
 * A `steps` value that is absent, explicitly null, or a bare array of running steps has no
 * catalogue ids to check — `prescriptionOf` is the only reader of the column's shape, here
 * as everywhere, so the discriminant rule is stated in one place and consulted in the rest.
 */
export const strengthEntriesOf = (
  steps: StoredPrescription | null | undefined,
): StrengthExercise[] | null => {
  const prescription = prescriptionOf(steps)
  return prescription?.kind === 'strength' ? prescription.exercises : null
}
