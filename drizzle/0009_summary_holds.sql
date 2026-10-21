CREATE TABLE `summary_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`run_id` text NOT NULL,
	`round` integer NOT NULL,
	`highlights` text NOT NULL,
	`prose` text NOT NULL,
	`verdicts` text NOT NULL,
	`gate_failures` integer NOT NULL,
	`style_score` integer NOT NULL,
	`grounded_figures` integer NOT NULL,
	`judge_fingerprint` text,
	`finish_reason` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `summaries` ADD `status` text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE `summaries` ADD `held_reason` text;--> statement-breakpoint
ALTER TABLE `summaries` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `summaries` ADD `release_note` text;