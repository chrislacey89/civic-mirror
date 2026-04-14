import { sql } from "drizzle-orm";
import {
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Star schema with `meetings` at the center.
 *
 * governingBodies ──< meetings ──< documents
 *                          ├──< transcripts
 *                          ├──< summaries
 *                          ├──< fiscalDecisions
 *                          └──< budgetDiscussions
 *
 * Every child table references `meetings.id` via a foreign key, so a single
 * meeting record fans out to all of its related artifacts.
 */

/**
 * Local government bodies that Civic Mirror tracks.
 * Each body has a unique slug used in URL routing
 * (e.g. `/meetings/ellettsville-town-council/2026-03-23`) and optional
 * source-specific identifiers for scraping (eGov search type, YouTube
 * playlist, Finalsite URL).
 */
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

/**
 * A single meeting session. The composite of (bodyId, date) is the natural key
 * used for lookups — e.g. "Ellettsville Town Council on 2026-03-23."
 */
export const meetings = sqliteTable(
	"meetings",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		bodyId: integer("body_id")
			.notNull()
			.references(() => governingBodies.id),
		date: text().notNull(), // ISO date string YYYY-MM-DD
		meetingType: text("meeting_type").notNull().default("regular"), // "regular" | "special" | "workshop"
		createdAt: integer("created_at", { mode: "timestamp" }).default(
			sql`(unixepoch())`,
		),
	},
	(table) => [
		// (bodyId, date) is the natural key — see block comment above. The unique
		// index turns that into a DB-enforced invariant so the weekly ingestion
		// cron can't silently produce duplicate meeting rows on re-run.
		uniqueIndex("meetings_body_id_date_unique").on(table.bodyId, table.date),
	],
);

/**
 * Source documents (agendas, minutes, ordinances) scraped from the eGov portal.
 * `rawText` holds the extracted text content from the PDF, which becomes the
 * input for the LLM summarization step. `sourceUrl` links back to the original.
 *
 * `extractionMethod` records which path produced `rawText`:
 *   - `text-layer`: PDF had a native text layer (fast path, high fidelity)
 *   - `ocr`:        rasterize + tesseract fallback for scanned/image-only PDFs
 *   - `unreadable`: neither path yielded text; `rawText` is empty and no
 *                   summary or fiscal decisions are stored for the meeting,
 *                   but the document row still exists so the meeting appears
 *                   in listings with a link to the source PDF.
 *
 * Default `'text-layer'` keeps pre-OCR rows valid without a backfill.
 */
export const documents = sqliteTable("documents", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	meetingId: integer("meeting_id")
		.notNull()
		.references(() => meetings.id),
	sourceUrl: text("source_url").notNull(),
	rawText: text("raw_text").notNull(),
	documentType: text("document_type").notNull(), // "agenda" | "minutes" | "ordinance"
	extractionMethod: text("extraction_method").notNull().default("text-layer"), // "text-layer" | "ocr" | "unreadable"
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

/**
 * Meeting transcripts sourced from YouTube captions or Whisper speech-to-text.
 * `segments` stores timestamped chunks as JSON, enabling future features like
 * "jump to the moment they discussed this budget item."
 */
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

/**
 * LLM-generated meeting summaries. Each summary includes structured highlights
 * (JSON array of bullet-point strings) and a prose paragraph. The `model` field
 * records which LLM produced the summary for reproducibility and auditing.
 */
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

/**
 * Structured spending data extracted from meeting minutes — the core value prop.
 *
 * Stores both the parsed numeric `amount` and the raw `originalAmount` string
 * (e.g. "$50,000") to enable two-pass verification: if the originalAmount
 * string doesn't appear in the source text, the `confidence` score gets
 * downgraded, signaling the LLM may have hallucinated or confused a historical
 * reference with a new decision.
 *
 * The `confidence` field (0.0–1.0) lets the UI visually distinguish
 * high-confidence decisions from uncertain ones.
 */
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

/**
 * Budget topics that were discussed but not voted on. Separated from
 * `fiscalDecisions` so the UI can clearly distinguish "they approved X"
 * from "they talked about Y." This prevents citizens from mistaking a
 * discussion item for a committed expenditure.
 */
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
