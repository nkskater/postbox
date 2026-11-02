DROP INDEX `vault_secrets_name_unique`;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `domains` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `owner_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_name_unique` ON `vault_secrets` (`workspace_id`,`name`,`owner_id`);