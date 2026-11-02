CREATE TABLE `specification_links` (
	`folder_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`specification_id` text NOT NULL,
	`spec_version` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`baseline` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE cascade
);
