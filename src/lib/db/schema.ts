/**
 * Drizzle schema — the source of truth for D1. Regenerate migrations with `pnpm db:generate`.
 *
 * Multi-tenant, but only just: a handful of invited athletes, each with one block of
 * ~23 weeks and ~150 activities in it. That is why there is still no outbox, no tombstone
 * table and no materialised training-load table — everything derived is cheap enough to
 * compute on read, per athlete, on every request.
 *
 * Every athlete-owned row carries `userId`, and every read filters on it. A query without
 * that filter is a bug of the same class as a missing auth check.
 */
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
// A leaf module with no imports, so loading this schema never drags `block.ts` and its
// `import.meta.env` into drizzle-kit's CommonJS transform. See `session-types.ts`.
import { SESSION_TYPES } from '../session-types'
import type { StoredPrescription } from '../prescription'
import type { StrengthExercise } from '../strength'

const now = sql`(unixepoch() * 1000)`

/**
 * The slice of Strava's athlete record worth keeping: enough to render "connected as X"
 * and nothing more. Declared here rather than in `strava.ts` because it is the shape the
 * `strava_accounts.athlete` column is typed by, and the column is the only thing that
 * outlives a request.
 */
export interface StravaAthlete {
  id: number
  firstname: string | null
  lastname: string | null
  profile: string | null
}

/**
 * One row per athlete. Accounts exist because an admin minted a single-use invite — there
 * is no open sign-up, so there is no email verification and no self-service reset either;
 * the admin re-invites.
 *
 * `passwordHash` is empty exactly once, on the owner row the migration plants: that is the
 * "not bootstrapped yet" marker `POST /api/bootstrap` looks for, and no password can hash
 * to empty.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // uuid
  /** Normalised (`trim().toLowerCase()`) on write *and* on lookup, so it is a real key. */
  email: text('email').notNull().unique(),
  /** base64 PBKDF2-SHA256 derived key; see `password.ts` for the iteration count. */
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(), // base64, 16 bytes
  displayName: text('display_name').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  /** Per-athlete max HR; the five zones are shares of it. Null → DEFAULT_HR_MAX. */
  hrMax: integer('hr_max'),
  /** Which frozen CSV season this athlete may compare against. Only the owner has one. */
  baselineKey: text('baseline_key'),
  /**
   * SHA-256 of this athlete's MCP bearer token, or null until they mint one on `/ajustes`.
   *
   * The hash and not the token, for the same reason `invites` stores a hash: it is shown
   * once, at mint time, so a database dump hands over fingerprints rather than working
   * credentials for every athlete's training data. Unique because it is what `/api/mcp`
   * looks a caller up by, and a collision would be one athlete's agent writing into
   * another's plan.
   */
  mcpTokenHash: text('mcp_token_hash').unique(),
  /**
   * The exact private R2 key of this athlete's current 512 px WebP avatar.
   *
   * A new random key is written for every replacement, so the app can expose a long-lived
   * immutable URL without a stale object ever changing underneath it. Null keeps initials
   * as the zero-storage fallback.
   */
  avatarKey: text('avatar_key'),
  createdAt: integer('created_at').notNull().default(now),
})

/**
 * Single-use invite links. The token is shown once, at mint time, and only its SHA-256
 * hex is stored — a database dump hands over no working links.
 *
 * `usedAt` is the lock: claiming is an `UPDATE ... WHERE used_at IS NULL`, so two people
 * opening the same link cannot both get an account out of it.
 */
export const invites = sqliteTable('invites', {
  tokenHash: text('token_hash').primaryKey(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Free text — "para Marc". The admin's own note, never shown to the invitee. */
  note: text('note'),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  /** Kept when the account is deleted, so a spent invite still reads as spent. */
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull().default(now),
})

/**
 * One active block per athlete — the dates every week index, every pace band and every
 * metric counts from. Keyed on `userId` alone: an athlete has one block at a time, and a
 * second one would mean deciding which of them `/` is about.
 */
export const blocks = sqliteTable('blocks', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Monday 00:00, epoch ms as local wall clock — same convention as every other date. */
  startsOn: integer('starts_on').notNull(),
  raceOn: integer('race_on').notNull(),
  goalTimeS: integer('goal_time_s').notNull(),
  raceDistanceM: real('race_distance_m').notNull(),
  raceName: text('race_name').notNull(),
  /** Where it is run — the town on the bib. Nullable: a race always has a name, and an
   * athlete who does not care where theirs is should not have to invent one. */
  racePlace: text('race_place'),
  updatedAt: integer('updated_at').notNull().default(now),
})

/**
 * The Strava connection, one row per athlete who made one. Replaces the old single-row
 * `app_state`, whose two values were both per-athlete facts wearing a global coat.
 *
 * `athleteId` is unique because it is the only way back from a webhook — the event body
 * carries `owner_id` and nothing else that identifies us — and because one Strava account
 * feeding two athletes' totals would be silent, wrong data.
 */
export const stravaAccounts = sqliteTable('strava_accounts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  athleteId: integer('athlete_id').notNull().unique(),
  athlete: text('athlete', { mode: 'json' }).$type<StravaAthlete>(),
  /** AES-GCM ciphertext. Strava rotates it on every refresh, so it must be persisted. */
  refreshToken: text('refresh_token').notNull(),
  lastSyncAt: integer('last_sync_at'),
  updatedAt: integer('updated_at').notNull().default(now),
})

/**
 * Activities inside an athlete's training block. Nothing before `block.startsOn` is
 * synced — for the owner, the 2020–2026 history lives in docs/personal/data/*.csv, where the
 * analysis that needed it already happened.
 *
 * `id` stays the whole primary key: Strava activity ids are globally unique, so two
 * athletes cannot collide even when they ran together. `userId` is here to filter by, and
 * the index leads with it because every query does.
 *
 * Units follow Strava exactly (metres, seconds, m/s) so sync never converts; paces are
 * derived at read time.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: integer('id').primaryKey(), // Strava activity id
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sportType: text('sport_type').notNull(),
    /** Local wall clock, epoch ms — "which day was this run", independent of viewer. */
    startedOn: integer('started_on').notNull(),
    distanceM: real('distance_m').notNull(),
    movingS: integer('moving_s').notNull(),
    elevationGainM: real('elevation_gain_m'),
    averageHeartrate: real('average_heartrate'),
    maxHeartrate: real('max_heartrate'),
    /** Steps per minute — already doubled from Strava's rpm. The knee-protocol marker. */
    cadenceSpm: integer('cadence_spm'),
    sufferScore: integer('suffer_score'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_activities_user_date').on(t.userId, t.startedOn)],
)

/**
 * One row per week of an athlete's block — the layer the plan is actually steered from.
 * Phase, volume target and down-week are decided a phase at a time and revised as the
 * body reports back, so every column is nullable and hand-editable.
 *
 * `(userId, weekIndex)` is the whole key: the Monday a week starts on is
 * `block.startsOn + i * WEEK_MS`, so storing a date too would be a second copy of the same
 * fact, free to drift.
 */
export const planWeeks = sqliteTable(
  'plan_weeks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekIndex: integer('week_index').notNull(), // 0-based from block.startsOn
    /** Free text, not an enum — phase boundaries are expected to move mid-block. */
    phase: text('phase'),
    focus: text('focus'),
    targetVolumeM: real('target_volume_m'),
    isDownWeek: integer('is_down_week', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekIndex] })],
)

/**
 * Prescribed sessions, one row each — written by hand or by an agent over MCP, then edited in
 * the app.
 *
 * The week a session belongs to is derived from `scheduledOn` rather than stored — moving
 * a session to another day must not be able to leave a stale week behind it.
 *
 * `id` is a stable slug (`w03-tue-1`) so re-seeding or re-generating resets in place
 * instead of duplicating; sessions created in the app get a UUID. Those slugs collide
 * across athletes by construction, which is why the key is `(userId, id)`.
 */
export const planSessions = sqliteTable(
  'plan_sessions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    /** Local date at 00:00, epoch ms — the same wall clock `activities.startedOn` uses. */
    scheduledOn: integer('scheduled_on').notNull(),
    /** Orders sessions within a day, so a double day (run + strength) has a fixed sequence. */
    dayOrder: integer('day_order').notNull().default(0),
    type: text('type', { enum: SESSION_TYPES }).notNull(),
    title: text('title').notNull(),
    /** Coaching prose — terrain, cadence, what to abort on. Never the numbers themselves. */
    notes: text('notes'),
    /**
     * What the session prescribes, as data. Stored as JSON rather than a `plan_steps`
     * table because a step has no identity of its own — it is never queried, sorted or
     * joined, only read back whole with the session that owns it. `null` for a session
     * that is just a distance at a pace.
     *
     * Historically named, and deliberately not renamed: the column holds a *prescription*
     * now, of which a bare array of running steps is one encoding — the original one, so
     * every row written before this existed reads back unchanged with no migration. A
     * strength day stores `{kind:'strength', exercises:[…]}` instead. `prescription.ts`
     * owns the discriminant rule and is the only place allowed to test the shape.
     */
    steps: text('steps', { mode: 'json' }).$type<StoredPrescription>(),
    targetDistanceM: real('target_distance_m'),
    /** For sessions measured in time, not distance — strength, cycling, cross-training. */
    targetDurationS: integer('target_duration_s'),
    targetPaceLoSKm: real('target_pace_lo_s_km'), // faster bound
    targetPaceHiSKm: real('target_pace_hi_s_km'), // slower bound
    /**
     * Set only when ticked off by hand — for strength and cross sessions, which never
     * reach Strava. Runs are matched to an activity on read instead, so a completed run
     * needs no write at all.
     */
    doneAt: integer('done_at'),
    /** Pins this session to one activity, overriding the read-time match when it guesses wrong. */
    activityId: integer('activity_id').references(() => activities.id, { onDelete: 'set null' }),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('idx_sessions_user_date').on(t.userId, t.scheduledOn, t.dayOrder),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Invite = typeof invites.$inferSelect
export type NewInvite = typeof invites.$inferInsert
export type Block = typeof blocks.$inferSelect
export type NewBlock = typeof blocks.$inferInsert
export type StravaAccount = typeof stravaAccounts.$inferSelect
export type NewStravaAccount = typeof stravaAccounts.$inferInsert
export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert
export type PlanWeek = typeof planWeeks.$inferSelect
export type NewPlanWeek = typeof planWeeks.$inferInsert
/**
 * Reusable strength prescriptions, one row per template — the library a Fuerza day is
 * stamped from, never the day itself.
 *
 * A template carries no date on purpose, which is the whole reason it is not a
 * `plan_sessions` row: `scheduled_on` is `NOT NULL` because a session without a day is not
 * a session. Applying a template *copies* its content onto a session (title ← name, notes,
 * targetDurationS, steps ← `{kind:'strength', exercises}`), so revising a template in
 * November can never rewrite a session already prescribed — still less one already
 * trained. That is the same rule as everywhere else in this schema: a finished record must
 * not change under you. There is deliberately no `template_id` on `plan_sessions` — a
 * back-reference would be a column with no reader and a standing invitation to "sync" what
 * was copied.
 *
 * `exercises` is JSON on the row for the reason `plan_sessions.steps` is: an entry has no
 * identity of its own. Each names a catalogue exercise by id (or none, for a written-in
 * move) and carries the prescription — series, repeticiones o segundos, descanso, carga.
 * The Spanish name is on the entry itself, so the row still renders if a re-vendored
 * catalogue ever drops the id: the catalogue enriches on read, it is not load-bearing.
 *
 * `id` is a stable slug over MCP (`fuerza-lunes`) and a UUID from the app, exactly like
 * `plan_sessions` — and those slugs collide across athletes by construction, which is why
 * the key is `(userId, id)` and every statement filters on `userId`. Ids beginning
 * `treximo-` are reserved for the built-in templates that ship in code and never have rows.
 */
export const workoutTemplates = sqliteTable(
  'workout_templates',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** Coaching prose for the whole block — cuándo progresar, qué señales respetar. */
    notes: text('notes'),
    exercises: text('exercises', { mode: 'json' }).$type<StrengthExercise[]>().notNull(),
    /** What the session it becomes is measured in — a strength day never has a distance. */
    targetDurationS: integer('target_duration_s'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  // No second index: the primary key already leads with `userId`, and the only query shape
  // is `WHERE user_id = ?` with an optional `AND id = ?`.
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
)

export type PlanSession = typeof planSessions.$inferSelect
export type NewPlanSession = typeof planSessions.$inferInsert
export type WorkoutTemplate = typeof workoutTemplates.$inferSelect
export type NewWorkoutTemplate = typeof workoutTemplates.$inferInsert
