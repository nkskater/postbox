ALTER TABLE `collection_forks` ADD `kind` text DEFAULT 'collection' NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_forks` ADD `base_files` text;--> statement-breakpoint
ALTER TABLE `merge_requests` ADD `kind` text DEFAULT 'collection' NOT NULL;