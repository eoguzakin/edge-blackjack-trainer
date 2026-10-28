CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`username_key` text,
	`password_hash` text,
	`chips` integer DEFAULT 2000 NOT NULL,
	`solo_state` text,
	`active_room` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_request` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "nonnegative_chips" CHECK("accounts"."chips" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_key_unique` ON `accounts` (`username_key`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_expiry` ON `rate_limits` (`expires`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`last_request` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires`);--> statement-breakpoint
CREATE TABLE `write_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "atomic_write_conflict" CHECK("write_checks"."ok" = 1)
);
