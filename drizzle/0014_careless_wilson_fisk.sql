CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`actor_kind` text NOT NULL,
	`via` text,
	`key_id` text,
	`workspace_id` text,
	`action` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text,
	`entity_name` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`result` text DEFAULT 'ok' NOT NULL,
	`method` text,
	`path` text,
	`changes` text NOT NULL,
	`meta` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_workspace_idx` ON `audit_events` (`workspace_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_events` (`actor_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_events` (`entity_kind`,`entity_id`);