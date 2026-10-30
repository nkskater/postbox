CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`workspace_id` text,
	`role` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_workspace_idx` ON `invites` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
INSERT INTO user_settings (user_id, key, value, updated_at) SELECT u.id, s.key, s.value, s.updated_at FROM app_settings s JOIN users u ON u.id = (SELECT id FROM users WHERE is_admin=1 AND disabled=0 ORDER BY created_at,id LIMIT 1) WHERE s.key IN ('appearance.theme','appearance.accent','appearance.tone','appearance.oled','appearance.fontSize','appearance.fontFamily','appearance.density','appearance.radius','appearance.reduceMotion','layout.sidebarPosition','layout.sidebarLabels','layout.requestLayout','editor.fontSize','editor.fontFamily','editor.lineHeight','editor.lineNumbers','editor.folding','editor.wrap','editor.tabSize','editor.brackets','editor.activeLine','editor.variableAutocomplete','editor.highlightUnresolved','requests.defaultMethod','requests.defaultRawLanguage','requests.timeoutMs','requests.followRedirects','requests.maxRedirects','requests.verifySsl','requests.useCookieJar','requests.trimUrl','requests.curlPaste','responses.defaultView','responses.wrap','responses.maxRenderKb','responses.openTestsOnFailure','tabs.previewOnClick','tabs.restore','tabs.confirmCloseUnsaved','tabs.maxOpen','variables.revealSecrets','variables.tooltips','console.maxEntries','console.timestamps','console.openOnError','runner.delayMs','runner.stopOnFailure','runner.persistVariables','runner.verifySsl','runner.reportFormat');
--> statement-breakpoint
DELETE FROM app_settings WHERE key IN ('appearance.theme','appearance.accent','appearance.tone','appearance.oled','appearance.fontSize','appearance.fontFamily','appearance.density','appearance.radius','appearance.reduceMotion','layout.sidebarPosition','layout.sidebarLabels','layout.requestLayout','editor.fontSize','editor.fontFamily','editor.lineHeight','editor.lineNumbers','editor.folding','editor.wrap','editor.tabSize','editor.brackets','editor.activeLine','editor.variableAutocomplete','editor.highlightUnresolved','requests.defaultMethod','requests.defaultRawLanguage','requests.timeoutMs','requests.followRedirects','requests.maxRedirects','requests.verifySsl','requests.useCookieJar','requests.trimUrl','requests.curlPaste','responses.defaultView','responses.wrap','responses.maxRenderKb','responses.openTestsOnFailure','tabs.previewOnClick','tabs.restore','tabs.confirmCloseUnsaved','tabs.maxOpen','variables.revealSecrets','variables.tooltips','console.maxEntries','console.timestamps','console.openOnError','runner.delayMs','runner.stopOnFailure','runner.persistVariables','runner.verifySsl','runner.reportFormat') AND EXISTS (SELECT 1 FROM users WHERE is_admin=1 AND disabled=0);
