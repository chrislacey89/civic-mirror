CREATE TABLE `held_videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`body_id` integer NOT NULL,
	`video_id` text NOT NULL,
	`title` text NOT NULL,
	`meeting_date` text,
	`reason` text NOT NULL,
	`probability` real,
	`shared_identifiers` integer,
	`candidate_meeting_id` integer,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`body_id`) REFERENCES `governing_bodies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `held_videos_video_id_unique` ON `held_videos` (`video_id`);