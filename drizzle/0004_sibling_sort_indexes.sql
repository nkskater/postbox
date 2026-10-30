CREATE INDEX `folders_workspace_parent_sort_idx` ON `folders` (`workspace_id`,`parent_id`,`sort`);--> statement-breakpoint
CREATE INDEX `requests_folder_sort_idx` ON `requests` (`folder_id`,`sort`);