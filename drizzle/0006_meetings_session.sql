DROP INDEX `meetings_body_id_date_unique`;--> statement-breakpoint
ALTER TABLE `meetings` ADD `session` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_body_id_date_session_unique` ON `meetings` (`body_id`,`date`,`session`);