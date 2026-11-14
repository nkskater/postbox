CREATE TABLE `workflow_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`environment_id` text,
	`cron` text,
	`webhook_enabled` integer DEFAULT false NOT NULL,
	`webhook_hash` text,
	`actor` text NOT NULL,
	`input` text NOT NULL,
	`last_run_id` text,
	`last_error` text,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_deployments_workspace_idx` ON `workflow_deployments` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `workflow_deployments_workflow_idx` ON `workflow_deployments` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer,
	`source_revision` integer,
	`content_hash` text NOT NULL,
	`deployment_id` text,
	`actor` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`trace` text NOT NULL,
	`error` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`trace_omitted` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`idempotency_hash` text,
	`input_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `workflow_deployments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workspace_created_idx` ON `workflow_runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_idempotency_idx` ON `workflow_runs` (`deployment_id`,`idempotency_hash`);--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`workflow_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`graph` text NOT NULL,
	`artifact` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workflow_id`, `version`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_versions_workspace_idx` ON `workflow_versions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`graph` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published_version` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflows_workspace_idx` ON `workflows` (`workspace_id`,`updated_at`);