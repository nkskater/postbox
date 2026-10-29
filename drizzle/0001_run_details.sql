ALTER TABLE `run_results` ADD `path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_results` ADD `skipped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `run_results` ADD `script_errors` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_results` ADD `response_body` text;--> statement-breakpoint
ALTER TABLE `run_results` ADD `response_headers` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `failed_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `error` text;