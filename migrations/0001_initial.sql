CREATE TABLE `br_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`hash` text NOT NULL,
	`expires` integer NOT NULL,
	`attempts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`salt` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_customers` (
	`phone` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_rate` (
	`key` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `br_rate_key_created` ON `br_rate` (`key`,`created`);--> statement-breakpoint
CREATE TABLE `br_payment_requests` (
	`request_key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`csrf` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `br_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
