CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
ALTER TABLE `history` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `runs` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `schedules` ADD `created_by` text REFERENCES users(id);
--> statement-breakpoint
INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
SELECT w.id, u.id, 'owner', w.created_at FROM workspaces w JOIN users u
ON u.id = (SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY created_at, id LIMIT 1);
--> statement-breakpoint
UPDATE schedules SET created_by = (SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY created_at, id LIMIT 1) WHERE created_by IS NULL;
