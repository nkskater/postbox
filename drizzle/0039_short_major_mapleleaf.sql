CREATE TABLE `dependency_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`release_id` text NOT NULL,
	`source_workspace_id` text NOT NULL,
	`source_folder_id` text NOT NULL,
	`source_name` text NOT NULL,
	`version` text NOT NULL,
	`checksum` text NOT NULL,
	`base_snapshot` text NOT NULL,
	`node_map` text NOT NULL,
	`installed_by` text,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_installs_folder_idx` ON `dependency_installs` (`folder_id`);--> statement-breakpoint
CREATE INDEX `dependency_installs_workspace_idx` ON `dependency_installs` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `dependency_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`seq` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`visibility` text NOT NULL,
	`checksum` text NOT NULL,
	`snapshot` text NOT NULL,
	`folder_count` integer DEFAULT 0 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	`revoked_by` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_releases_version_idx` ON `dependency_releases` (`folder_id`,`version`);--> statement-breakpoint
CREATE INDEX `dependency_releases_workspace_idx` ON `dependency_releases` (`workspace_id`);