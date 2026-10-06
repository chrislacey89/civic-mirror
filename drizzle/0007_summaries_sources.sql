ALTER TABLE `summaries` ADD `source_kinds` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `summaries` ADD `source_fingerprint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `summaries` ADD `source_disagreements` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_meeting_id_unique` ON `summaries` (`meeting_id`);