CREATE TABLE `sso_identities` (
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`provider_id`, `subject`),
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sso_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`secrets` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sso_replay_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sso_role_grants` (
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`),
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sso_states` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`browser_hash` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
