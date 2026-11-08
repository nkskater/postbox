CREATE TABLE `runner_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_jobs_run_id_unique` ON `runner_jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `runner_jobs_queue_idx` ON `runner_jobs` (`runner_id`,`status`);--> statement-breakpoint
CREATE INDEX `runner_jobs_monitor_idx` ON `runner_jobs` (`monitor_id`,`status`);--> statement-breakpoint
CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`labels` text NOT NULL,
	`token_hash` text NOT NULL,
	`share_secrets` integer DEFAULT false NOT NULL,
	`allow_hosts` text NOT NULL,
	`deny_hosts` text NOT NULL,
	`version` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runners_token_hash_unique` ON `runners` (`token_hash`);--> statement-breakpoint
CREATE INDEX `runners_workspace_idx` ON `runners` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `monitor_samples` ADD `runner_id` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `runner_id` text;--> statement-breakpoint
CREATE INDEX `monitors_runner_idx` ON `monitors` (`runner_id`);