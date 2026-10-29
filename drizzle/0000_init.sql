CREATE TABLE `cookies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`expires` integer,
	`http_only` integer DEFAULT false NOT NULL,
	`secure` integer DEFAULT false NOT NULL,
	`same_site` text,
	`host_only` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cookies_identity_idx` ON `cookies` (`workspace_id`,`domain`,`path`,`name`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`auth` text NOT NULL,
	`headers` text NOT NULL,
	`pre_request_script` text DEFAULT '' NOT NULL,
	`test_script` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `folders_workspace_idx` ON `folders` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `folders_parent_idx` ON `folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_id` text,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`status` integer,
	`time_ms` integer,
	`size` integer,
	`request` text NOT NULL,
	`response` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_workspace_idx` ON `history` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`method` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`params` text NOT NULL,
	`headers` text NOT NULL,
	`body` text NOT NULL,
	`auth` text NOT NULL,
	`pre_request_script` text DEFAULT '' NOT NULL,
	`test_script` text DEFAULT '' NOT NULL,
	`settings` text NOT NULL,
	`examples` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `requests_folder_idx` ON `requests` (`folder_id`);--> statement-breakpoint
CREATE TABLE `run_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`sequence` integer NOT NULL,
	`request_id` text,
	`name` text NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`status` integer,
	`status_text` text,
	`time_ms` integer,
	`size` integer,
	`tests` text NOT NULL,
	`error` text,
	`passed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_results_run_idx` ON `run_results` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`options` text NOT NULL,
	`environment_id` text,
	`iterations` integer DEFAULT 1 NOT NULL,
	`total_requests` integer DEFAULT 0 NOT NULL,
	`total_tests` integer DEFAULT 0 NOT NULL,
	`passed_tests` integer DEFAULT 0 NOT NULL,
	`failed_tests` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_workspace_idx` ON `runs` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`folder_id` text NOT NULL,
	`environment_id` text,
	`cron` text NOT NULL,
	`options` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'default' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `variables_scope_idx` ON `variables` (`workspace_id`,`scope`,`owner_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
