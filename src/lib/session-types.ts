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
