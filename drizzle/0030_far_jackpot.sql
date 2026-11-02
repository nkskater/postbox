CREATE TABLE `monitor_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`locked_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`incident_id`) REFERENCES `monitor_incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_email_event_unique` ON `monitor_emails` (`incident_id`,`kind`,`recipient`);--> statement-breakpoint
CREATE INDEX `monitor_email_due_idx` ON `monitor_emails` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `monitor_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	`reasons` text NOT NULL,
	`opening_run_id` text NOT NULL,
	`recovery_run_id` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitor_incidents_time_idx` ON `monitor_incidents` (`monitor_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `monitor_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`run_id` text NOT NULL,
	`at` integer NOT NULL,
	`outcome` text NOT NULL,
	`metrics` text NOT NULL,
	`reasons` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_samples_run_id_unique` ON `monitor_samples` (`run_id`);--> statement-breakpoint
CREATE INDEX `monitor_samples_time_idx` ON `monitor_samples` (`monitor_id`,`at`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`rules` text NOT NULL,
	`emails` text NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`open_incident_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_schedule_id_unique` ON `monitors` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `monitors_workspace_idx` ON `monitors` (`workspace_id`);