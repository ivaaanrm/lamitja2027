CREATE TABLE `plan_weeks` (
	`week_index` integer PRIMARY KEY NOT NULL,
	`phase` text,
	`focus` text,
	`target_volume_m` real,
	`is_down_week` integer DEFAULT false NOT NULL,
	`notes` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
DROP INDEX `idx_sessions_date`;--> statement-breakpoint
ALTER TABLE `plan_sessions` ADD `day_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_sessions` ADD `target_duration_s` integer;--> statement-breakpoint
ALTER TABLE `plan_sessions` ADD `activity_id` integer REFERENCES activities(id);--> statement-breakpoint
CREATE INDEX `idx_sessions_date` ON `plan_sessions` (`scheduled_on`,`day_order`);