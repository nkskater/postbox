ALTER TABLE `dependency_installs` ADD `kind` text DEFAULT 'collection' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_releases` ADD `kind` text DEFAULT 'collection' NOT NULL;