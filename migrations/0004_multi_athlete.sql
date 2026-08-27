-- Multi-athlete: four tables become eight, and every athlete-owned row gains an owner.
--
-- Hand-written body over drizzle's generated one — the single documented exception to
-- "never hand-edit migrations". Two things the generator cannot know: it drops app_state
-- before anything reads the Strava credentials out of it, and it adds `user_id` with
-- `ALTER TABLE ... ADD ... NOT NULL REFERENCES`, which SQLite rejects outright (a REFERENCES
-- column must default to NULL, and a NOT NULL column may not). So the three existing tables
-- are rebuilt the way drizzle rebuilds a table, with every existing row handed to 'owner' —
-- the athlete this database already belongs to.
--
-- Every backfill is guarded with WHERE EXISTS so this also runs clean against an empty
-- database (a fresh preview, a fresh CI run).

-- 1. The new tables. `users` first: the other three point at it.
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`display_name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`hr_max` integer,
	`baseline_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `invites` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `blocks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`starts_on` integer NOT NULL,
	`race_on` integer NOT NULL,
	`goal_time_s` integer NOT NULL,
	`race_distance_m` real NOT NULL,
	`race_name` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `strava_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`athlete` text,
	`refresh_token` text NOT NULL,
	`last_sync_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strava_accounts_athlete_id_unique` ON `strava_accounts` (`athlete_id`);--> statement-breakpoint

-- 2. The owner. The empty password_hash is the "not bootstrapped yet" marker
-- POST /api/bootstrap looks for — no password can hash to empty — and it is what lets the
-- existing athlete claim this row with a real email and password instead of a script.
-- The email is a placeholder for the same reason; bootstrap overwrites it.
INSERT INTO `users` (`id`, `email`, `password_hash`, `password_salt`, `display_name`, `is_admin`, `hr_max`, `baseline_key`, `created_at`)
VALUES ('owner', 'owner@lamitja.local', '', '', 'Ivan', 1, NULL, 'ivan-2025-26', (unixepoch() * 1000));--> statement-breakpoint

-- 3. The owner's block: LAMITJA_2027, the numbers docs/03 was written against.
-- Date.UTC(2026, 7, 17) and Date.UTC(2027, 0, 24) as epoch ms.
INSERT INTO `blocks` (`user_id`, `starts_on`, `race_on`, `goal_time_s`, `race_distance_m`, `race_name`, `updated_at`)
VALUES ('owner', 1786924800000, 1800748800000, 4799, 21097.5, 'La Mitja', (unixepoch() * 1000));--> statement-breakpoint

-- 4. The Strava connection, lifted out of app_state's three keys. Gated on the athlete id
-- as well as the token: athlete_id is the only way a webhook's `owner_id` finds its user,
-- so a row without one would be worse than no row at all — and reconnecting is one tap.
INSERT INTO `strava_accounts` (`user_id`, `athlete_id`, `athlete`, `refresh_token`, `last_sync_at`, `updated_at`)
SELECT
	'owner',
	CAST(json_extract((SELECT `value` FROM `app_state` WHERE `key` = 'strava.athlete'), '$.id') AS INTEGER),
	(SELECT `value` FROM `app_state` WHERE `key` = 'strava.athlete'),
	(SELECT `value` FROM `app_state` WHERE `key` = 'strava.refresh_token'),
	CAST((SELECT `value` FROM `app_state` WHERE `key` = 'sync.last_at') AS INTEGER),
	(unixepoch() * 1000)
WHERE EXISTS (SELECT 1 FROM `app_state` WHERE `key` = 'strava.refresh_token')
	AND json_extract((SELECT `value` FROM `app_state` WHERE `key` = 'strava.athlete'), '$.id') IS NOT NULL;--> statement-breakpoint

-- 5. Rebuild the three athlete-owned tables. foreign_keys=OFF is what drizzle wraps a
-- rebuild in; defer_foreign_keys=ON is what carries it when D1 runs the whole file as one
-- transaction, where toggling foreign_keys is a no-op. Both are no-ops for the other case,
-- and dropping `activities` with plan_sessions.activity_id still pointing at it needs one
-- of them to hold.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_activities` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sport_type` text NOT NULL,
	`started_on` integer NOT NULL,
	`distance_m` real NOT NULL,
	`moving_s` integer NOT NULL,
	`elevation_gain_m` real,
	`average_heartrate` real,
	`max_heartrate` real,
	`cadence_spm` integer,
	`suffer_score` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_activities`("id", "user_id", "name", "sport_type", "started_on", "distance_m", "moving_s", "elevation_gain_m", "average_heartrate", "max_heartrate", "cadence_spm", "suffer_score", "updated_at") SELECT "id", 'owner', "name", "sport_type", "started_on", "distance_m", "moving_s", "elevation_gain_m", "average_heartrate", "max_heartrate", "cadence_spm", "suffer_score", "updated_at" FROM `activities`;--> statement-breakpoint
DROP TABLE `activities`;--> statement-breakpoint
ALTER TABLE `__new_activities` RENAME TO `activities`;--> statement-breakpoint
CREATE INDEX `idx_activities_user_date` ON `activities` (`user_id`,`started_on`);--> statement-breakpoint
CREATE TABLE `__new_plan_weeks` (
	`user_id` text NOT NULL,
	`week_index` integer NOT NULL,
	`phase` text,
	`focus` text,
	`target_volume_m` real,
	`is_down_week` integer DEFAULT false NOT NULL,
	`notes` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `week_index`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_plan_weeks`("user_id", "week_index", "phase", "focus", "target_volume_m", "is_down_week", "notes", "updated_at") SELECT 'owner', "week_index", "phase", "focus", "target_volume_m", "is_down_week", "notes", "updated_at" FROM `plan_weeks`;--> statement-breakpoint
DROP TABLE `plan_weeks`;--> statement-breakpoint
ALTER TABLE `__new_plan_weeks` RENAME TO `plan_weeks`;--> statement-breakpoint
CREATE TABLE `__new_plan_sessions` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`scheduled_on` integer NOT NULL,
	`day_order` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`steps` text,
	`target_distance_m` real,
	`target_duration_s` integer,
	`target_pace_lo_s_km` real,
	`target_pace_hi_s_km` real,
	`done_at` integer,
	`activity_id` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_plan_sessions`("user_id", "id", "scheduled_on", "day_order", "type", "title", "notes", "steps", "target_distance_m", "target_duration_s", "target_pace_lo_s_km", "target_pace_hi_s_km", "done_at", "activity_id", "updated_at") SELECT 'owner', "id", "scheduled_on", "day_order", "type", "title", "notes", "steps", "target_distance_m", "target_duration_s", "target_pace_lo_s_km", "target_pace_hi_s_km", "done_at", "activity_id", "updated_at" FROM `plan_sessions`;--> statement-breakpoint
DROP TABLE `plan_sessions`;--> statement-breakpoint
ALTER TABLE `__new_plan_sessions` RENAME TO `plan_sessions`;--> statement-breakpoint
CREATE INDEX `idx_sessions_user_date` ON `plan_sessions` (`user_id`,`scheduled_on`,`day_order`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint

-- 6. app_state is gone: both of its values were per-athlete facts wearing a global coat.
DROP TABLE `app_state`;
