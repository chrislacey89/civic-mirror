CREATE TABLE `budget_discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`topic` text NOT NULL,
	`estimated_amount` real,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`source_url` text NOT NULL,
	`raw_text` text NOT NULL,
	`document_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fiscal_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`original_amount` text NOT NULL,
	`budget_category` text,
	`status` text DEFAULT 'approved' NOT NULL,
	`vote_record` text,
	`vendor` text,
	`funding_source` text,
	`ordinance_number` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`is_recurring` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `governing_bodies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`egov_search_type` text,
	`youtube_playlist_id` text,
	`finalsite_url` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `governing_bodies_slug_unique` ON `governing_bodies` (`slug`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`body_id` integer NOT NULL,
	`date` text NOT NULL,
	`meeting_type` text DEFAULT 'regular' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`body_id`) REFERENCES `governing_bodies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`highlights` text NOT NULL,
	`prose` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`raw_text` text NOT NULL,
	`segments` text,
	`source_url` text,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
