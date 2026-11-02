CREATE TABLE `governance_bindings` (
	`specification_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`rule_set_id` text NOT NULL,
	`rule_version` integer,
	`overrides` text DEFAULT '{}' NOT NULL,
	`exclusions` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_set_id`) REFERENCES `governance_rule_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `governance_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`specification_id` text NOT NULL,
	`spec_version` integer NOT NULL,
	`rule_set_id` text NOT NULL,
	`rule_version` integer NOT NULL,
	`binding_revision` integer NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_set_id`) REFERENCES `governance_rule_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `governance_reports_spec_time` ON `governance_reports` (`specification_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `governance_rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `governance_rule_versions` (
	`rule_set_id` text NOT NULL,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`rule_set_id`, `version`),
	FOREIGN KEY (`rule_set_id`) REFERENCES `governance_rule_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
