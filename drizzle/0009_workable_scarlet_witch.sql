CREATE TABLE `dataset_versions` (
	`dataset_id` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`secret_columns` text NOT NULL,
	`row_count` integer NOT NULL,
	`columns` text NOT NULL,
	`missing_secrets` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	PRIMARY KEY(`dataset_id`, `version`),
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`latest_version` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `datasets_workspace_idx` ON `datasets` (`workspace_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `runs` ADD `dataset_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `dataset_version` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `dataset_name` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `dataset_id` text REFERENCES datasets(id);--> statement-breakpoint
ALTER TABLE `schedules` ADD `dataset_version` integer;