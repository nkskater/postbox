CREATE TABLE `mock_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`mock_id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`example_id` text,
	`duration_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mock_id`) REFERENCES `mock_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mock_logs_time_idx` ON `mock_logs` (`mock_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mock_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`match_query` integer DEFAULT true NOT NULL,
	`match_body` integer DEFAULT true NOT NULL,
	`delay_ms` integer DEFAULT 0 NOT NULL,
	`status` integer,
	`headers` text NOT NULL,
	`routes` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mock_workspace_idx` ON `mock_servers` (`workspace_id`);