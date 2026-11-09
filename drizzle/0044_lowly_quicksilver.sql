CREATE TABLE `scim_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`external_id` text,
	`members` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_workspace_name_unique` ON `scim_groups` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `scim_groups_workspace_idx` ON `scim_groups` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `scim_profile` text;--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;