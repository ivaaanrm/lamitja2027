ALTER TABLE `users` ADD `mcp_token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_mcp_token_hash_unique` ON `users` (`mcp_token_hash`);