CREATE TABLE `admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`target_id` text NOT NULL,
	`changed_fields` text NOT NULL,
	`before_value` text NOT NULL,
	`after_value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `admin_audit_target_time` ON `admin_audit` (`target_id`,`created_at`);