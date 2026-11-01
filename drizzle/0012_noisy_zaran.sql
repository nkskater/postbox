CREATE TABLE `grpc_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`files` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `grpc_definitions_workspace_idx` ON `grpc_definitions` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `grpc_definitions_name_unique` ON `grpc_definitions` (`workspace_id`,`name`);