CREATE TABLE `collection_forks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`parent_workspace_id` text NOT NULL,
	`parent_folder_id` text NOT NULL,
	`parent_name` text NOT NULL,
	`base_snapshot` text NOT NULL,
	`node_map` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_forks_folder_idx` ON `collection_forks` (`folder_id`);--> statement-breakpoint
CREATE INDEX `collection_forks_workspace_idx` ON `collection_forks` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `collection_forks_parent_idx` ON `collection_forks` (`parent_folder_id`);--> statement-breakpoint
CREATE TABLE `merge_request_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`merge_request_id` text NOT NULL,
	`reviewer_id` text,
	`reviewer_name` text NOT NULL,
	`decision` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`head_checksum` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merge_request_reviews_idx` ON `merge_request_reviews` (`merge_request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `merge_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`fork_id` text NOT NULL,
	`fork_workspace_id` text NOT NULL,
	`fork_folder_id` text NOT NULL,
	`parent_folder_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_by` text,
	`created_by_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`closed_note` text,
	`merged_at` integer,
	`merged_by_name` text,
	`merged_summary` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fork_id`) REFERENCES `collection_forks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merge_requests_workspace_idx` ON `merge_requests` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `merge_requests_fork_idx` ON `merge_requests` (`fork_id`);