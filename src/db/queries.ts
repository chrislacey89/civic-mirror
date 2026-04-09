import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema.ts";

export type FiscalDecisionDetail = {
	title: string;
	description: string;
	amount: number;
	originalAmount: string;
	budgetCategory: string | null;
	status: string;
	voteRecord: { yea: number; nay: number; abstain: number } | null;
	vendor: string | null;
	fundingSource: string | null;
	ordinanceNumber: string | null;
	confidence: number;
	isRecurring: boolean;
};

/**
 * The "read shape" — a fully assembled meeting with all related records
 * joined together. This is what the server function returns to the UI.
 */
export type MeetingDetail = {
	id: number;
	date: string;
	meetingType: string;
	bodyName: string;
	bodySlug: string;
	documents: Array<{
		sourceUrl: string;
		rawText: string;
		documentType: string;
	}>;
	summary: { highlights: string[]; prose: string; model: string };
	fiscalDecisions: Array<FiscalDecisionDetail>;
	budgetDiscussions: Array<{
		topic: string;
		estimatedAmount: number | null;
		notes: string | null;
	}>;
};

/**
 * Read-side query that assembles the full meeting detail from multiple tables.
 * Uses individual queries rather than a single JOIN for readability and because
 * SQLite's query planner handles simple primary-key lookups efficiently.
 *
 * Returns `null` at the first missing piece (no body, no meeting, no summary)
 * rather than returning partial data.
 */
export function getMeetingByBodyAndDateQuery(
	db: BetterSQLite3Database<typeof schema>,
	slug: string,
	date: string,
): MeetingDetail | null {
	const body = db
		.select()
		.from(schema.governingBodies)
		.where(eq(schema.governingBodies.slug, slug))
		.get();

	if (!body) return null;

	const meeting = db
		.select()
		.from(schema.meetings)
		.where(
			and(eq(schema.meetings.bodyId, body.id), eq(schema.meetings.date, date)),
		)
		.get();

	if (!meeting) return null;

	const docs = db
		.select()
		.from(schema.documents)
		.where(eq(schema.documents.meetingId, meeting.id))
		.all();

	const summary = db
		.select()
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meeting.id))
		.get();

	if (!summary) return null;

	const fiscals = db
		.select()
		.from(schema.fiscalDecisions)
		.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
		.all();

	const discussions = db
		.select()
		.from(schema.budgetDiscussions)
		.where(eq(schema.budgetDiscussions.meetingId, meeting.id))
		.all();

	return {
		id: meeting.id,
		date: meeting.date,
		meetingType: meeting.meetingType,
		bodyName: body.name,
		bodySlug: body.slug,
		documents: docs.map((d) => ({
			sourceUrl: d.sourceUrl,
			rawText: d.rawText,
			documentType: d.documentType,
		})),
		summary: {
			highlights: summary.highlights as string[],
			prose: summary.prose,
			model: summary.model,
		},
		fiscalDecisions: fiscals.map((f) => ({
			title: f.title,
			description: f.description,
			amount: f.amount,
			originalAmount: f.originalAmount,
			budgetCategory: f.budgetCategory,
			status: f.status,
			voteRecord: f.voteRecord as {
				yea: number;
				nay: number;
				abstain: number;
			} | null,
			vendor: f.vendor,
			fundingSource: f.fundingSource,
			ordinanceNumber: f.ordinanceNumber,
			confidence: f.confidence,
			isRecurring: f.isRecurring,
		})),
		budgetDiscussions: discussions.map((bd) => ({
			topic: bd.topic,
			estimatedAmount: bd.estimatedAmount,
			notes: bd.notes,
		})),
	};
}
