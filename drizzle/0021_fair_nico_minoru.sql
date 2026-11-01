CREATE TABLE `hook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`listener_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`query` text NOT NULL,
	`headers` text NOT NULL,
	`body` text NOT NULL,
	`body_encoding` text NOT NULL,
	`body_bytes` integer NOT NULL,
	`signature` text NOT NULL,
	`response_status` integer NOT NULL,
	`forward_status` integer,
	`forward_error` text,
	`forwarded_at` integer,
	`replays` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`listener_id`) REFERENCES `hook_listeners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hook_events_listener_idx` ON `hook_events` (`listener_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `hook_listeners` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`verification` text NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`response_status` integer DEFAULT 200 NOT NULL,
	`response_content_type` text DEFAULT 'application/json' NOT NULL,
	`response_body` text DEFAULT '{"ok":true}' NOT NULL,
	`forward_url` text,
	`rate_per_minute` integer DEFAULT 120 NOT NULL,
	`received_count` integer DEFAULT 0 NOT NULL,
	`last_received_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hook_listeners_token_hash_unique` ON `hook_listeners` (`token_hash`);--> statement-breakpoint
CREATE INDEX `hook_listeners_workspace_idx` ON `hook_listeners` (`workspace_id`);