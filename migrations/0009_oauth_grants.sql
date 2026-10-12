CREATE TABLE `oauth_grants` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`client_host` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`resource` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_challenge` text NOT NULL,
	`code_expires_at` integer NOT NULL,
	`code_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_code_hash_unique` ON `oauth_grants` (`code_hash`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`user_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`hash` text NOT NULL,
	`kind` text NOT NULL,
	`parent_hash` text,
	`expires_at` integer NOT NULL,
	`retired_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`grant_id`) REFERENCES `oauth_grants`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_hash_unique` ON `oauth_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_grant_idx` ON `oauth_tokens` (`user_id`,`grant_id`);