CREATE TABLE `usage_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`limit_id` text NOT NULL,
	`workspace_id` text DEFAULT '' NOT NULL,
	`user_id` text,
	`metric` text NOT NULL,
	`kind` text NOT NULL,
	`period_start` integer NOT NULL,
	`used` integer NOT NULL,
	`limit_value` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_alert_unique` ON `usage_alerts` (`limit_id`,`workspace_id`,`kind`,`period_start`);--> statement-breakpoint
CREATE INDEX `usage_alert_at_idx` ON `usage_alerts` (`at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text,
	`metric` text NOT NULL,
	`amount` integer NOT NULL,
	`idem_key` text
);
--> statement-breakpoint
CREATE INDEX `usage_workspace_idx` ON `usage_events` (`workspace_id`,`metric`,`at`);--> statement-breakpoint
CREATE INDEX `usage_actor_idx` ON `usage_events` (`actor_id`,`metric`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_idem_unique` ON `usage_events` (`workspace_id`,`idem_key`);--> statement-breakpoint
CREATE TABLE `usage_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`metric` text NOT NULL,
	`period` text DEFAULT 'month' NOT NULL,
	`soft_limit` integer,
	`hard_limit` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
