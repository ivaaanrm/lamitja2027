/**
 * The session vocabulary, on its own, importing nothing.
 *
 * It lived in `plan.ts` — where it still reads most naturally — and `db/schema.ts` imported
 * it from there so the browser could have the vocabulary without drizzle coming with it.
 * That worked until `plan.ts` grew an import of `block.ts`, which imports `config.ts`,
 * which reads `import.meta.env`: drizzle-kit loads the schema through a CommonJS transform,
 * and `import.meta` is a *syntax* error there, not a runtime one. So `pnpm db:generate`
 * stopped working — with a stack trace pointing at `block.ts` and no mention of the enum
 * that dragged it in.
 *
 * A leaf module with no imports of its own is the fix, and it is the right shape anyway: a
 * list of nine strings is not something that should be able to break a build tool by
 * acquiring a transitive dependency. `plan.ts` re-exports both names, so nothing that
 * already reads them from there had to change.
 */
export const SESSION_TYPES = [
  'easy',
  'long',
  'tempo',
  'interval',
  'fartlek',
  'race',
  'rest',
  'cross',
  'strength',
] as const

export type SessionType = (typeof SESSION_TYPES)[number]

/**
 * What a session *prescribes*, as opposed to what it is called.
 *
 * `SESSION_TYPES` answers "which card is this" — nine labels, nine colours, nine rows in
 * `SESSION_META`. This answers "what shape is the payload on the row", and the two are
 * deliberately not the same list: six run types share one prescription shape, `rest` and
 * `cross` prescribe nothing at all, and a future kind (a nutrition day) would add a type
 * *and* a kind without either list implying the other.
 *
 * It lives here rather than beside the union in `prescription.ts` for the reason
 * `SESSION_TYPES` does: `db/schema.ts` and drizzle-kit's CommonJS transform must be able
 * to reach the vocabulary without dragging `import.meta.env` in behind it.
 */
export const PRESCRIPTION_KINDS = ['run', 'strength'] as const

export type PrescriptionKindName = (typeof PRESCRIPTION_KINDS)[number]

/**
 * What a session type is measured in, and which activities can satisfy it.
 *
 * Here rather than in `plan.ts` because a prescription strategy declares one too, and
 * `prescription.ts` may not import `plan.ts` — the graph runs the other way. `plan.ts`
 * re-exports it exactly as it re-exports `SESSION_TYPES`, so nothing that already reads it
 * from there had to change.
 */
export type SportFamily = 'run' | 'strength' | 'other'
