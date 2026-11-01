ALTER TABLE `api_tokens` ADD `scope` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `rate_limit_per_minute` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `is_service` integer DEFAULT false NOT NULL;