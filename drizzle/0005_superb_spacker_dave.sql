CREATE TABLE `drama_assessments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`level` text NOT NULL,
	`confidence` real NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`headline` text NOT NULL,
	`narrative` text NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drama_assessments_meeting_prompt_model_unique` ON `drama_assessments` (`meeting_id`,`prompt_version`,`model`);--> statement-breakpoint
CREATE TABLE `drama_category_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`assessment_id` integer NOT NULL,
	`category` text NOT NULL,
	`score` integer NOT NULL,
	`evidence_quotes` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`assessment_id`) REFERENCES `drama_assessments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drama_category_scores_assessment_category_unique` ON `drama_category_scores` (`assessment_id`,`category`);