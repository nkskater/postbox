CREATE TABLE `catalog_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`tags` text NOT NULL,
	`owners` text NOT NULL,
	`visibility` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer NOT NULL,
	`latest_version` integer NOT NULL,
	`latest_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_folder_unique` ON `catalog_entries` (`folder_id`);--> statement-breakpoint
CREATE INDEX `catalog_visibility_updated_idx` ON `catalog_entries` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE INDEX `catalog_workspace_idx` ON `catalog_entries` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `catalog_versions` (
	`entry_id` text NOT NULL,
	`version` integer NOT NULL,
	`label` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `version`),
	FOREIGN KEY (`entry_id`) REFERENCES `catalog_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_version_label_unique` ON `catalog_versions` (`entry_id`,`label`);