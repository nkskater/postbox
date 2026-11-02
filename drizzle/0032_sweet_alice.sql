CREATE TABLE `capture_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text NOT NULL,
	`request_body` text NOT NULL,
	`status` integer,
	`status_text` text DEFAULT '' NOT NULL,
	`response_headers` text DEFAULT '[]' NOT NULL,
	`response_body` text NOT NULL,
	`duration_ms` integer,
	`error` text,
	`redactions` integer DEFAULT 0 NOT NULL,
	`imported_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `capture_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `capture_entries_session_idx` ON `capture_entries` (`session_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `capture_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`allow_https` integer DEFAULT false NOT NULL,
	`https_consent_by` text,
	`https_consent_at` integer,
	`capture_cookies` integer DEFAULT false NOT NULL,
	`hosts` text DEFAULT '[]' NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`last_captured_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_sessions_token_hash_unique` ON `capture_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `capture_sessions_workspace_idx` ON `capture_sessions` (`workspace_id`);