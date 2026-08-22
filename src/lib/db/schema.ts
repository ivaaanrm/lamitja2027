/**
 * Drizzle schema — the source of truth for D1. Regenerate migrations with `pnpm db:generate`.
 *
 * Scope is deliberately small: one athlete, one 22-week block starting 24 Aug 2026.
 * That is ~130 activities by race day, which is why there is no outbox, no tombstone
 * table, no materialised training-load table and no multi-user plumbing — everything
 * derived is cheap enough to compute on read.
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
// Declared in `plan.ts` so the browser can read the session vocabulary without
// pulling drizzle into the client bundle.
import { SESSION_TYPES } from '../plan'

const now = sql`(unixepoch() * 1000)`

/**
 * Activities inside the training block. Nothing before `BLOCK_START` is synced — the
 * 2020–2026 history lives in docs/data/*.csv, where the analysis that needed it already
 * happened.
 *
 * Units follow Strava exactly (metres, seconds, m/s) so sync never converts; paces are
 * derived at read time.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: integer('id').primaryKey(), // Strava activity id
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
  (t) => [index('idx_activities_date').on(t.startedOn)],
)

/**
 * One row per week of the block — the layer the plan is actually steered from. Phase,
 * volume target and down-week are decided a phase at a time and revised as the knee
 * and the Phase 0 gate report back, so every column is nullable and hand-editable.
 *
 * `weekIndex` is the whole key: the Monday it starts on is `BLOCK_START + i * WEEK_MS`,
 * so storing a date too would be a second copy of the same fact, free to drift.
 */
export const planWeeks = sqliteTable('plan_weeks', {
  weekIndex: integer('week_index').primaryKey(), // 0-based from BLOCK_START
  /** Free text, not an enum — the phase boundaries in docs/03 are expected to move. */
  phase: text('phase'),
  focus: text('focus'),
  targetVolumeM: real('target_volume_m'),
  isDownWeek: integer('is_down_week', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  updatedAt: integer('updated_at').notNull().default(now),
})

/**
 * Prescribed sessions, one row each. Written and edited by hand in the app; there is no
 * generator, so nothing here is ever overwritten from a template.
 *
 * The week a session belongs to is derived from `scheduledOn` rather than stored — moving
 * a session to another day must not be able to leave a stale week behind it.
 *
 * `id` is text so a future seeder can use stable slugs (`w03-tue-1`) and upsert in place;
 * sessions created in the app get a UUID.
 */
export const planSessions = sqliteTable(
  'plan_sessions',
  {
    id: text('id').primaryKey(),
    /** Local date at 00:00, epoch ms — the same wall clock `activities.startedOn` uses. */
    scheduledOn: integer('scheduled_on').notNull(),
    /** Orders sessions within a day, so a double day (run + strength) has a fixed sequence. */
    dayOrder: integer('day_order').notNull().default(0),
    type: text('type', { enum: SESSION_TYPES }).notNull(),
    title: text('title').notNull(),
    /** The workout as prose — "6×1000 @ 3:50, 90s jog". Deliberately not a step structure. */
    notes: text('notes'),
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
  (t) => [index('idx_sessions_date').on(t.scheduledOn, t.dayOrder)],
)

/**
 * Single-row key/value store. Holds the Strava refresh token (AES-GCM encrypted) and the
 * last-sync cursor — a whole table each would be ceremony for two values.
 */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
})

export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert
export type PlanWeek = typeof planWeeks.$inferSelect
export type NewPlanWeek = typeof planWeeks.$inferInsert
export type PlanSession = typeof planSessions.$inferSelect
export type NewPlanSession = typeof planSessions.$inferInsert
