CREATE TABLE `documentation_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`title` text NOT NULL,
	`visibility` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer NOT NULL,
	`custom_origin` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documentation_folder_unique` ON `documentation_publications` (`folder_id`);--> statement-breakpoint
CREATE INDEX `documentation_workspace_idx` ON `documentation_publications` (`workspace_id`);