CREATE TABLE `graph_edges` (
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text NOT NULL,
	`origin` text NOT NULL,
	`props` text NOT NULL,
	PRIMARY KEY(`source_id`, `from_id`, `type`, `to_id`),
	FOREIGN KEY (`source_id`) REFERENCES `graph_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_edges_workspace_idx` ON `graph_edges` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `graph_edges_from_idx` ON `graph_edges` (`from_id`);--> statement-breakpoint
CREATE INDEX `graph_edges_to_idx` ON `graph_edges` (`to_id`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`source_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`workspace_id` text,
	`label` text NOT NULL,
	`props` text NOT NULL,
	PRIMARY KEY(`source_id`, `id`),
	FOREIGN KEY (`source_id`) REFERENCES `graph_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_nodes_id_idx` ON `graph_nodes` (`id`);--> statement-breakpoint
CREATE INDEX `graph_nodes_workspace_idx` ON `graph_nodes` (`workspace_id`,`kind`);--> statement-breakpoint
CREATE TABLE `graph_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`label` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`connected` integer DEFAULT true NOT NULL,
	`indexed_at` integer NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_sources_workspace_idx` ON `graph_sources` (`workspace_id`,`kind`);