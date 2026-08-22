/**
 * Drizzle schema — the single source of truth for the D1 database.
 * Migrations are generated from this file with `pnpm db:generate`; never hand-edit
 * the SQL in `migrations/`.
 *
 * Conventions:
 *   - Dates are INTEGER epoch **milliseconds** (indexable range scans, no string parsing).
 *   - `updatedAt` exists on every client-mirrored table and drives the delta-sync cursor.
 *   - Units follow Strava exactly — metres, seconds, m/s — so sync never converts.
 *     Paces (s/km) are derived at read time, never stored.
 */
import { relations, sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch() * 1000)`

// ------------------------------------------------------------------ identity

export const athletes = sqliteTable('athletes', {
  id: integer('id').primaryKey(), // Strava athlete id
  username: text('username'),
  firstname: text('firstname'),
  lastname: text('lastname'),
  sex: text('sex'),
  weightKg: real('weight_kg'),
  profileUrl: text('profile_url'),
  country: text('country'),
  /** Gate checked on every OAuth callback. Nobody gets in without it. */
  allowlisted: integer('allowlisted', { mode: 'boolean' }).notNull().default(false),
  /** JSON: units, HR zones, injury status. */
  prefs: text('prefs', { mode: 'json' }).$type<AthletePrefs>().notNull().default({}),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export interface AthletePrefs {
  hrMax?: number
  hrRest?: number
  /** ITBS traffic-light state, drives the periodizer's returnToRun gating. */
  kneeStatus?: 'green' | 'amber' | 'red'
  targetCadence?: number
}

/**
 * Strava tokens. Both token columns hold AES-GCM ciphertext, encrypted under the
 * TOKEN_ENC_KEY secret — a leaked D1 dump must not hand over the Strava account.
 */
export const oauthTokens = sqliteTable('oauth_tokens', {
  athleteId: integer('athlete_id')
    .primaryKey()
    .references(() => athletes.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: integer('expires_at').notNull(),
  scope: text('scope').notNull().default(''),
  updatedAt: integer('updated_at').notNull().default(now),
})

// ------------------------------------------------------------------ activity

export const activities = sqliteTable(
  'activities',
  {
    id: integer('id').primaryKey(), // Strava activity id
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athletes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sportType: text('sport_type').notNull(),
    startAt: integer('start_at').notNull(),
    /** Shifted to the athlete's local wall clock — what "which day was this run" means. */
    startLocalAt: integer('start_local_at').notNull(),
    timezone: text('timezone'),
    distanceM: real('distance_m').notNull(),
    movingS: integer('moving_s').notNull(),
    elapsedS: integer('elapsed_s').notNull(),
    elevationGainM: real('elevation_gain_m'),
    averageSpeed: real('average_speed'),
    maxSpeed: real('max_speed'),
    averageHeartrate: real('average_heartrate'),
    maxHeartrate: real('max_heartrate'),
    /** Strava reports rpm (one leg); doubled to spm at read time. The knee protocol's key marker. */
    averageCadence: real('average_cadence'),
    averageWatts: real('average_watts'),
    sufferScore: integer('suffer_score'),
    startLat: real('start_lat'),
    startLng: real('start_lng'),
    summaryPolyline: text('summary_polyline'),
    hasLaps: integer('has_laps', { mode: 'boolean' }).notNull().default(false),
    /** Computed by lib/training/load.ts on sync. */
    trimp: real('trimp'),
    /** Full Strava JSON, so reprocessing never needs a refetch against the rate limit. */
    raw: text('raw', { mode: 'json' }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('idx_activities_athlete_start').on(t.athleteId, t.startAt),
    index('idx_activities_updated').on(t.updatedAt),
    index('idx_activities_sport').on(t.athleteId, t.sportType, t.startAt),
  ],
)

export const laps = sqliteTable(
  'laps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: integer('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    lapIndex: integer('lap_index').notNull(),
    name: text('name'),
    distanceM: real('distance_m').notNull(),
    movingS: integer('moving_s').notNull(),
    elapsedS: integer('elapsed_s').notNull(),
    elevationGainM: real('elevation_gain_m'),
    averageSpeed: real('average_speed'),
    maxSpeed: real('max_speed'),
    averageHeartrate: real('average_heartrate'),
    maxHeartrate: real('max_heartrate'),
    averageCadence: real('average_cadence'),
    paceZone: integer('pace_zone'),
    startAt: integer('start_at'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('uq_laps_activity_index').on(t.activityId, t.lapIndex),
    index('idx_laps_updated').on(t.updatedAt),
  ],
)

// ---------------------------------------------------------------------- plan

export const races = sqliteTable(
  'races',
  {
    id: text('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athletes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    raceDate: integer('race_date').notNull(),
    distanceM: real('distance_m').notNull(),
    goalTimeS: integer('goal_time_s'),
    actualTimeS: integer('actual_time_s'),
    /** The one race the plan is built around. */
    isTarget: integer('is_target', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_races_athlete').on(t.athleteId, t.raceDate)],
)

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athletes.id, { onDelete: 'cascade' }),
    raceId: text('race_id').references(() => races.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    methodology: text('methodology').notNull(),
    /** The exact engine inputs, so any plan can be regenerated byte-identically. */
    params: text('params', { mode: 'json' }).notNull().default({}),
    startsOn: integer('starts_on').notNull(),
    endsOn: integer('ends_on').notNull(),
    status: text('status', { enum: ['active', 'archived', 'superseded'] })
      .notNull()
      .default('active'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_plans_athlete').on(t.athleteId, t.status)],
)

export const PHASES = ['rebuild', 'base', 'threshold', 'race-specific', 'taper'] as const
export type Phase = (typeof PHASES)[number]

export const planWeeks = sqliteTable(
  'plan_weeks',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    weekIndex: integer('week_index').notNull(), // 0-based from plan start
    startsOn: integer('starts_on').notNull(), // Monday
    phase: text('phase', { enum: PHASES }).notNull(),
    targetVolumeM: real('target_volume_m').notNull(),
    isDownWeek: integer('is_down_week', { mode: 'boolean' }).notNull().default(false),
    focus: text('focus'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('uq_plan_week').on(t.planId, t.weekIndex)],
)

export const SESSION_TYPES = [
  'easy',
  'long',
  'tempo',
  'interval',
  'repetition',
  'recovery',
  'race',
  'rest',
  'cross',
  'strength',
] as const
export type SessionType = (typeof SESSION_TYPES)[number]

/** Structured workout, e.g. 2 km warmup + 5×1 km @ threshold w/ 90s + 2 km cooldown. */
export interface SessionStructure {
  warmupM?: number
  cooldownM?: number
  reps?: Array<{
    count: number
    distanceM?: number
    durationS?: number
    paceLoSKm?: number
    paceHiSKm?: number
    recoveryS?: number
    recoveryM?: number
  }>
}

export const planSessions = sqliteTable(
  'plan_sessions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    weekIndex: integer('week_index').notNull(),
    scheduledOn: integer('scheduled_on').notNull(), // local date at 00:00
    type: text('type', { enum: SESSION_TYPES }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    targetDistanceM: real('target_distance_m'),
    targetDurationS: integer('target_duration_s'),
    targetPaceLoSKm: real('target_pace_lo_s_km'), // faster bound
    targetPaceHiSKm: real('target_pace_hi_s_km'), // slower bound
    structure: text('structure', { mode: 'json' }).$type<SessionStructure>(),
    /** Drives the >=80%-easy guardrail. Kept explicit rather than derived from `type`. */
    intensity: text('intensity', { enum: ['easy', 'quality'] })
      .notNull()
      .default('easy'),
    status: text('status', { enum: ['planned', 'completed', 'missed', 'moved'] })
      .notNull()
      .default('planned'),
    matchedActivityId: integer('matched_activity_id').references(() => activities.id, {
      onDelete: 'set null',
    }),
    /** Original `scheduledOn`, when the session was dragged to another day. */
    movedFrom: integer('moved_from'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('idx_sessions_plan_date').on(t.planId, t.scheduledOn),
    index('idx_sessions_updated').on(t.updatedAt),
    index('idx_sessions_matched').on(t.matchedActivityId),
  ],
)

// ------------------------------------------------------------------- derived

/** Materialised so charts never recompute a year of exponential averages client-side. */
export const fitnessDaily = sqliteTable(
  'fitness_daily',
  {
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athletes.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(), // local midnight
    load: real('load').notNull().default(0), // that day's TRIMP
    ctl: real('ctl').notNull().default(0), // chronic training load, 42d
    atl: real('atl').notNull().default(0), // acute training load, 7d
    tsb: real('tsb').notNull().default(0), // form = ctl - atl
    distanceM: real('distance_m').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('uq_fitness_athlete_day').on(t.athleteId, t.day),
    index('idx_fitness_updated').on(t.updatedAt),
  ],
)

export const coachBriefs = sqliteTable(
  'coach_briefs',
  {
    id: text('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athletes.id, { onDelete: 'cascade' }),
    weekStart: integer('week_start').notNull(), // Monday
    model: text('model').notNull(),
    /** Hash of the engine digest; regeneration is skipped while this is unchanged. */
    inputDigest: text('input_digest').notNull(),
    brief: text('brief', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('uq_brief_athlete_week').on(t.athleteId, t.weekStart)],
)

// ------------------------------------------------------------------- syncing

export const syncState = sqliteTable('sync_state', {
  athleteId: integer('athlete_id')
    .primaryKey()
    .references(() => athletes.id, { onDelete: 'cascade' }),
  /** Newest `startAt` seen — the `after` cursor for Strava's activity list. */
  lastActivityAt: integer('last_activity_at').notNull().default(0),
  /** Oldest `startAt` fetched — the `before` cursor while walking history backwards. */
  backfillBefore: integer('backfill_before'),
  backfillComplete: integer('backfill_complete', { mode: 'boolean' }).notNull().default(false),
  lastFullSyncAt: integer('last_full_sync_at'),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const JOB_KINDS = [
  'activity.upsert',
  'activity.delete',
  'laps.fetch',
  'backfill.page',
] as const
export type JobKind = (typeof JOB_KINDS)[number]

/**
 * Durable outbox. Webhooks enqueue here and return 200 immediately; the
 * quarter-hourly cron drains it with backoff. This is what removes the need for
 * Cloudflare Queues.
 */
export const syncJobs = sqliteTable(
  'sync_jobs',
  {
    id: text('id').primaryKey(),
    athleteId: integer('athlete_id').notNull(),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    payload: text('payload', { mode: 'json' }).notNull().default({}),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_jobs_due').on(t.status, t.nextAttemptAt)],
)

/** Tombstones, so the client mirror can delete rows it already holds. */
export const deletions = sqliteTable(
  'deletions',
  {
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    athleteId: integer('athlete_id').notNull(),
    deletedAt: integer('deleted_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('uq_deletion').on(t.entity, t.entityId),
    index('idx_deletions_at').on(t.athleteId, t.deletedAt),
  ],
)

// ----------------------------------------------------------------- relations

export const athleteRelations = relations(athletes, ({ many, one }) => ({
  activities: many(activities),
  plans: many(plans),
  races: many(races),
  tokens: one(oauthTokens, { fields: [athletes.id], references: [oauthTokens.athleteId] }),
  syncState: one(syncState, { fields: [athletes.id], references: [syncState.athleteId] }),
}))

export const activityRelations = relations(activities, ({ many, one }) => ({
  athlete: one(athletes, { fields: [activities.athleteId], references: [athletes.id] }),
  laps: many(laps),
}))

export const lapRelations = relations(laps, ({ one }) => ({
  activity: one(activities, { fields: [laps.activityId], references: [activities.id] }),
}))

export const planRelations = relations(plans, ({ many, one }) => ({
  athlete: one(athletes, { fields: [plans.athleteId], references: [athletes.id] }),
  race: one(races, { fields: [plans.raceId], references: [races.id] }),
  weeks: many(planWeeks),
  sessions: many(planSessions),
}))

export const planWeekRelations = relations(planWeeks, ({ one }) => ({
  plan: one(plans, { fields: [planWeeks.planId], references: [plans.id] }),
}))

export const planSessionRelations = relations(planSessions, ({ one }) => ({
  plan: one(plans, { fields: [planSessions.planId], references: [plans.id] }),
  matchedActivity: one(activities, {
    fields: [planSessions.matchedActivityId],
    references: [activities.id],
  }),
}))

export type Athlete = typeof athletes.$inferSelect
export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert
export type Lap = typeof laps.$inferSelect
export type NewLap = typeof laps.$inferInsert
export type PlanSession = typeof planSessions.$inferSelect
export type SyncJob = typeof syncJobs.$inferSelect
