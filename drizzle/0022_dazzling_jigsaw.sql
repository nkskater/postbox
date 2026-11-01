CREATE TABLE `outbound_proxy` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`bypass` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tls_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`ca_pem` text DEFAULT '' NOT NULL,
	`cert_pem` text DEFAULT '' NOT NULL,
	`key_pem` text DEFAULT '' NOT NULL,
	`passphrase` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tls_profiles_name_unique` ON `tls_profiles` (`name`);