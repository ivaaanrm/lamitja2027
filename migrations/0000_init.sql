CREATE TABLE `activities` (
	`id` integer PRIMARY KEY NOT NULL,
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
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activities_date` ON `activities` (`started_on`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`week_index` integer NOT NULL,
	`scheduled_on` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`target_distance_m` real,
	`target_pace_lo_s_km` real,
	`target_pace_hi_s_km` real,
	`done_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_date` ON `plan_sessions` (`scheduled_on`);