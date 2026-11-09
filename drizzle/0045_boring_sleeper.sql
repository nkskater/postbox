CREATE TABLE `gateway_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`api_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`upstream_prefix` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`policy` text NOT NULL,
	`minute_window` integer DEFAULT 0 NOT NULL,
	`minute_used` integer DEFAULT 0 NOT NULL,
	`day_window` integer DEFAULT 0 NOT NULL,
	`day_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_id`) REFERENCES `broker_apis`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_routes_name_unique` ON `gateway_routes` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `gateway_sessions` (
	`route_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`route_id`, `session_hash`),
	FOREIGN KEY (`route_id`) REFERENCES `gateway_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `broker_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_sessions_workspace_expiry_idx` ON `gateway_sessions` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `gateway_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`route_id` text,
	`consumer_id` text,
	`method` text NOT NULL,
	`status` integer,
	`outcome` text NOT NULL,
	`code` text NOT NULL,
	`request_bytes` integer NOT NULL,
	`response_bytes` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `gateway_routes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gateway_traces_workspace_time_idx` ON `gateway_traces` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_traces_route_idx` ON `gateway_traces` (`route_id`,`started_at`);