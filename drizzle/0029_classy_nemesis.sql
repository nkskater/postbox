CREATE TABLE `broker_apis` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`base_url` text NOT NULL,
	`secret_name` text NOT NULL,
	`injection` text NOT NULL,
	`methods` text DEFAULT '[]' NOT NULL,
	`path_prefixes` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broker_apis_name_unique` ON `broker_apis` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `broker_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`api_id` text NOT NULL,
	`consumer_id` text NOT NULL,
	`consumer_name` text DEFAULT '' NOT NULL,
	`token_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`methods` text DEFAULT '[]' NOT NULL,
	`path_prefixes` text DEFAULT '[]' NOT NULL,
	`requested_by` text,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer,
	`last_used_at` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_id`) REFERENCES `broker_apis`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `broker_grants_api_idx` ON `broker_grants` (`api_id`);--> statement-breakpoint
CREATE INDEX `broker_grants_consumer_idx` ON `broker_grants` (`workspace_id`,`consumer_id`);