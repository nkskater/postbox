CREATE TABLE `telemetry_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`route_source` text NOT NULL,
	`status` integer,
	`error` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`at` integer NOT NULL,
	`service` text NOT NULL,
	`environment` text NOT NULL,
	`sample_rate` real NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `telemetry_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telemetry_span_unique` ON `telemetry_observations` (`source_id`,`trace_id`,`span_id`);--> statement-breakpoint
CREATE INDEX `telemetry_workspace_time_idx` ON `telemetry_observations` (`workspace_id`,`at`);--> statement-breakpoint
CREATE INDEX `telemetry_source_time_idx` ON `telemetry_observations` (`source_id`,`at`);--> statement-breakpoint
CREATE TABLE `telemetry_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`config` text NOT NULL,
	`token_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_intake` text,
	`last_received_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `telemetry_sources_workspace_idx` ON `telemetry_sources` (`workspace_id`);