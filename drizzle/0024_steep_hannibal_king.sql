CREATE TABLE `load_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`profile` text NOT NULL,
	`thresholds` text DEFAULT '[]' NOT NULL,
	`think_ms` integer DEFAULT 0 NOT NULL,
	`environment_id` text,
	`dataset_id` text,
	`dataset_version` integer,
	`result` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_by` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `load_runs_workspace_idx` ON `load_runs` (`workspace_id`,`started_at`);