import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const governingBodies = sqliteTable("governing_bodies", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	slug: text().notNull().unique(),
	type: text().notNull(), // "town" | "county" | "school"
	egovSearchType: text("egov_search_type"), // eGov document center search type ID
	youtubePlaylistId: text("youtube_playlist_id"),
	finalsiteUrl: text("finalsite_url"),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const meetings = sqliteTable("meetings", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	bodyId: integer("body_id")
		.notNull()
		.references(() => governingBodies.id),
	date: text().notNull(), // ISO date string YYYY-MM-DD
	meetingType: text("meeting_type").notNull().default("regular"), // "regular" | "special" | "workshop"
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const documents = sqliteTable("documents", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	sourceUrl: text("source_url").notNull(),
	rawText: text("raw_text").notNull(),
	documentType: text("document_type").notNull(), // "agenda" | "minutes" | "ordinance"
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const transcripts = sqliteTable("transcripts", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	source: text().notNull(), // "captions" | "whisper"
	rawText: text("raw_text").notNull(),
	segments: text({ mode: "json" }), // timestamped segments array
	sourceUrl: text("source_url"),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const summaries = sqliteTable("summaries", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	highlights: text({ mode: "json" }).notNull(), // string[]
	prose: text().notNull(),
	model: text().notNull(), // e.g. "gemini-2.5-flash"
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const fiscalDecisions = sqliteTable("fiscal_decisions", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	title: text().notNull(),
	description: text().notNull(),
	amount: real().notNull(),
	originalAmount: text("original_amount").notNull(), // raw string from source e.g. "$1,234.56"
	budgetCategory: text("budget_category"), // e.g. "infrastructure", "public-safety"
	status: text().notNull().default("approved"), // "approved" | "denied" | "tabled"
	voteRecord: text("vote_record", { mode: "json" }), // { yea: number, nay: number, abstain: number }
	vendor: text(),
	fundingSource: text("funding_source"),
	ordinanceNumber: text("ordinance_number"),
	confidence: real().notNull().default(1.0), // 0.0-1.0, lower when verification fails
	isRecurring: integer("is_recurring", { mode: "boolean" })
		.notNull()
		.default(false),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export const budgetDiscussions = sqliteTable("budget_discussions", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	topic: text().notNull(),
	estimatedAmount: real("estimated_amount"),
	notes: text(),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});
