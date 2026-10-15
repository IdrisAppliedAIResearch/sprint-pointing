CREATE TABLE `presence` (
	`room_id` text NOT NULL,
	`participant_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `participant_id`, `client_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `presence_seen` ON `presence` (`room_id`,`seen_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`credential` text,
	`expires_at` integer NOT NULL,
	`lease` text,
	`lock_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_expiry` ON `rooms` (`expires_at`);