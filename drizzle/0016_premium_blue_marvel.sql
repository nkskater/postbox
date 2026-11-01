CREATE TABLE `script_package_versions` (
	`package_id` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`hash` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`created_by` text,
	`approved_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`package_id`, `version`),
	FOREIGN KEY (`package_id`) REFERENCES `script_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `script_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`latest_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `script_packages_name_idx` ON `script_packages` (`workspace_id`,`name`);