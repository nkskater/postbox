ALTER TABLE `webhooks` ADD `format` text DEFAULT 'postbox' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `secret_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `routing_key_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `headers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `pause_after_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `failure_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `pause_reason` text DEFAULT '' NOT NULL;