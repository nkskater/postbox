CREATE TABLE `vault_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`ciphertext` text DEFAULT '' NOT NULL,
	`key_id` text DEFAULT '' NOT NULL,
	`script_access` integer DEFAULT false NOT NULL,
	`collection_ids` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`rotated_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_name_unique` ON `vault_secrets` (`workspace_id`,`name`);