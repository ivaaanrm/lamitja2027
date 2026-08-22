CREATE TABLE `activities` (
	`id` integer PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`name` text NOT NULL,
	`sport_type` text NOT NULL,
	`start_at` integer NOT NULL,
	`start_local_at` integer NOT NULL,
	`timezone` text,
	`distance_m` real NOT NULL,
	`moving_s` integer NOT NULL,
	`elapsed_s` integer NOT NULL,
	`elevation_gain_m` real,
	`average_speed` real,
	`max_speed` real,
	`average_heartrate` real,
	`max_heartrate` real,
	`average_cadence` real,
	`average_watts` real,
	`suffer_score` integer,
	`start_lat` real,
	`start_lng` real,
	`summary_polyline` text,
	`has_laps` integer DEFAULT false NOT NULL,
	`trimp` real,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_activities_athlete_start` ON `activities` (`athlete_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_updated` ON `activities` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_sport` ON `activities` (`athlete_id`,`sport_type`,`start_at`);--> statement-breakpoint
CREATE TABLE `athletes` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`firstname` text,
	`lastname` text,
	`sex` text,
	`weight_kg` real,
	`profile_url` text,
	`country` text,
	`allowlisted` integer DEFAULT false NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coach_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`week_start` integer NOT NULL,
	`model` text NOT NULL,
	`input_digest` text NOT NULL,
	`brief` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brief_athlete_week` ON `coach_briefs` (`athlete_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `deletions` (
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`athlete_id` integer NOT NULL,
	`deleted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deletion` ON `deletions` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_deletions_at` ON `deletions` (`athlete_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `fitness_daily` (
	`athlete_id` integer NOT NULL,
	`day` integer NOT NULL,
	`load` real DEFAULT 0 NOT NULL,
	`ctl` real DEFAULT 0 NOT NULL,
	`atl` real DEFAULT 0 NOT NULL,
	`tsb` real DEFAULT 0 NOT NULL,
	`distance_m` real DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_fitness_athlete_day` ON `fitness_daily` (`athlete_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_fitness_updated` ON `fitness_daily` (`updated_at`);--> statement-breakpoint
CREATE TABLE `laps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activity_id` integer NOT NULL,
	`lap_index` integer NOT NULL,
	`name` text,
	`distance_m` real NOT NULL,
	`moving_s` integer NOT NULL,
	`elapsed_s` integer NOT NULL,
	`elevation_gain_m` real,
	`average_speed` real,
	`max_speed` real,
	`average_heartrate` real,
	`max_heartrate` real,
	`average_cadence` real,
	`pace_zone` integer,
	`start_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_laps_activity_index` ON `laps` (`activity_id`,`lap_index`);--> statement-breakpoint
CREATE INDEX `idx_laps_updated` ON `laps` (`updated_at`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`athlete_id` integer PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plan_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`week_index` integer NOT NULL,
	`scheduled_on` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`target_distance_m` real,
	`target_duration_s` integer,
	`target_pace_lo_s_km` real,
	`target_pace_hi_s_km` real,
	`structure` text,
	`intensity` text DEFAULT 'easy' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`matched_activity_id` integer,
	`moved_from` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_plan_date` ON `plan_sessions` (`plan_id`,`scheduled_on`);--> statement-breakpoint
CREATE INDEX `idx_sessions_updated` ON `plan_sessions` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_matched` ON `plan_sessions` (`matched_activity_id`);--> statement-breakpoint
CREATE TABLE `plan_weeks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`week_index` integer NOT NULL,
	`starts_on` integer NOT NULL,
	`phase` text NOT NULL,
	`target_volume_m` real NOT NULL,
	`is_down_week` integer DEFAULT false NOT NULL,
	`focus` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_plan_week` ON `plan_weeks` (`plan_id`,`week_index`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`race_id` text,
	`name` text NOT NULL,
	`methodology` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`starts_on` integer NOT NULL,
	`ends_on` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`race_id`) REFERENCES `races`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_plans_athlete` ON `plans` (`athlete_id`,`status`);--> statement-breakpoint
CREATE TABLE `races` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`name` text NOT NULL,
	`race_date` integer NOT NULL,
	`distance_m` real NOT NULL,
	`goal_time_s` integer,
	`actual_time_s` integer,
	`is_target` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_races_athlete` ON `races` (`athlete_id`,`race_date`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_due` ON `sync_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`athlete_id` integer PRIMARY KEY NOT NULL,
	`last_activity_at` integer DEFAULT 0 NOT NULL,
	`backfill_before` integer,
	`backfill_complete` integer DEFAULT false NOT NULL,
	`last_full_sync_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
