import { and, desc, eq, sql, sum } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "#/db/schema.ts";

export type MeetingType = "regular" | "special" | "workshop";
export type FiscalStatus = "approved" | "denied" | "tabled";
export type BodyType = "town" | "county" | "school";

const MEETING_TYPES = new Set<string>(["regular", "special", "workshop"]);
const FISCAL_STATUSES = new Set<string>(["approved", "denied", "tabled"]);

function parseMeetingType(raw: string): MeetingType {
	if (MEETING_TYPES.has(raw)) return raw as MeetingType;
	throw new Error(`Invalid meeting type: ${raw}`);
}

function parseFiscalStatus(raw: string): FiscalStatus {
	if (FISCAL_STATUSES.has(raw)) return raw as FiscalStatus;
	throw new Error(`Invalid fiscal status: ${raw}`);
}

export type MeetingCardData = {
	id: number;
	date: string;
	meetingType: MeetingType;
	bodyName: string;
	bodySlug: string;
	highlights: string[];
	prose: string;
	fiscalDecisionCount: number;
	totalSpending: number;
};

export type FiscalByBody = {
	bodyName: string;
	bodySlug: string;
	totalAmount: number;
	decisionCount: number;
};

export type FiscalByCategory = {
	budgetCategory: string;
	totalAmount: number;
	decisionCount: number;
};

export type FiscalByTimePeriod = {
	period: string;
	totalAmount: number;
	decisionCount: number;
};

export type NotableFiscalDecision = {
	title: string;
	amount: number;
	status: FiscalStatus;
	bodyName: string;
	bodySlug: string;
	date: string;
};

export type FiscalDecisionRow = {
	title: string;
	amount: number;
	budgetCategory: string;
	status: FiscalStatus;
	bodyName: string;
	bodySlug: string;
	date: string;
};

export type GoverningBodySummary = {
	name: string;
	slug: string;
	type: BodyType;
};

/**
 * Lists recent meetings with summary data for the landing page feed.
 * Optionally filtered by body slug. Returns newest first.
 */
export async function listRecentMeetingsQuery(
	db: LibSQLDatabase<typeof schema>,
	bodySlug?: string,
	limit = 20,
): Promise<MeetingCardData[]> {
	let bodyFilter: number | undefined;
	if (bodySlug) {
		const body = await db
			.select()
			.from(schema.governingBodies)
			.where(eq(schema.governingBodies.slug, bodySlug))
			.get();
		if (!body) return [];
		bodyFilter = body.id;
	}

	const meetingRows = await db
		.select()
		.from(schema.meetings)
		.where(bodyFilter ? eq(schema.meetings.bodyId, bodyFilter) : undefined)
		.orderBy(desc(schema.meetings.date))
		.limit(limit)
		.all();

	const result: MeetingCardData[] = [];
	for (const m of meetingRows) {
		const body = await db
			.select()
			.from(schema.governingBodies)
			.where(eq(schema.governingBodies.id, m.bodyId))
			.get();
		if (!body) continue;

		const summary = await db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, m.id))
			.get();
		if (!summary) continue;

		const fiscals = await db
			.select()
			.from(schema.fiscalDecisions)
			.where(eq(schema.fiscalDecisions.meetingId, m.id))
			.all();

		result.push({
			id: m.id,
			date: m.date,
			meetingType: parseMeetingType(m.meetingType),
			bodyName: body.name,
			bodySlug: body.slug,
			highlights: summary.highlights as string[],
			prose: summary.prose,
			fiscalDecisionCount: fiscals.length,
			totalSpending: fiscals.reduce(
				(total: number, f: { amount: number }) => total + f.amount,
				0,
			),
		});
	}

	return result;
}

/**
 * Aggregates fiscal decision totals by governing body.
 */
export async function aggregateFiscalByBodyQuery(
	db: LibSQLDatabase<typeof schema>,
): Promise<FiscalByBody[]> {
	const rows = await db
		.select({
			bodyName: schema.governingBodies.name,
			bodySlug: schema.governingBodies.slug,
			totalAmount: sum(schema.fiscalDecisions.amount),
			decisionCount: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.innerJoin(
			schema.governingBodies,
			eq(schema.meetings.bodyId, schema.governingBodies.id),
		)
		.groupBy(schema.governingBodies.id)
		.all();

	return rows.map((r) => ({
		bodyName: r.bodyName,
		bodySlug: r.bodySlug,
		totalAmount: Number(r.totalAmount) || 0,
		decisionCount: r.decisionCount,
	}));
}

/**
 * Aggregates fiscal decision totals by budget category.
 */
export async function aggregateFiscalByCategoryQuery(
	db: LibSQLDatabase<typeof schema>,
): Promise<FiscalByCategory[]> {
	const rows = await db
		.select({
			budgetCategory: schema.fiscalDecisions.budgetCategory,
			totalAmount: sum(schema.fiscalDecisions.amount),
			decisionCount: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.groupBy(schema.fiscalDecisions.budgetCategory)
		.all();

	return rows.map((r) => ({
		budgetCategory: r.budgetCategory ?? "Uncategorized",
		totalAmount: Number(r.totalAmount) || 0,
		decisionCount: r.decisionCount,
	}));
}

/**
 * Aggregates fiscal decision totals by month (YYYY-MM).
 */
export async function aggregateFiscalByTimePeriodQuery(
	db: LibSQLDatabase<typeof schema>,
): Promise<FiscalByTimePeriod[]> {
	const rows = await db
		.select({
			period: sql<string>`substr(${schema.meetings.date}, 1, 7)`,
			totalAmount: sum(schema.fiscalDecisions.amount),
			decisionCount: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.groupBy(sql`substr(${schema.meetings.date}, 1, 7)`)
		.orderBy(desc(sql`substr(${schema.meetings.date}, 1, 7)`))
		.all();

	return rows.map((r) => ({
		period: r.period,
		totalAmount: Number(r.totalAmount) || 0,
		decisionCount: r.decisionCount,
	}));
}

/**
 * Returns the most notable recent fiscal decisions (highest amounts).
 */
export async function listNotableFiscalDecisionsQuery(
	db: LibSQLDatabase<typeof schema>,
	limit = 5,
): Promise<NotableFiscalDecision[]> {
	const rows = await db
		.select({
			title: schema.fiscalDecisions.title,
			amount: schema.fiscalDecisions.amount,
			status: schema.fiscalDecisions.status,
			bodyName: schema.governingBodies.name,
			bodySlug: schema.governingBodies.slug,
			date: schema.meetings.date,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.innerJoin(
			schema.governingBodies,
			eq(schema.meetings.bodyId, schema.governingBodies.id),
		)
		.orderBy(desc(schema.fiscalDecisions.amount))
		.limit(limit)
		.all();

	return rows.map((r) => ({
		title: r.title,
		amount: r.amount,
		status: parseFiscalStatus(r.status),
		bodyName: r.bodyName,
		bodySlug: r.bodySlug,
		date: r.date,
	}));
}

/**
 * Lists all fiscal decisions with meeting context for the spending dashboard.
 * Optionally filtered by body slug, budget category, or time period (YYYY-MM).
 * Each row includes bodySlug and date for deep linking to meeting detail pages.
 */
export async function listFiscalDecisionsQuery(
	db: LibSQLDatabase<typeof schema>,
	filters?: { bodySlug?: string; category?: string; period?: string },
): Promise<FiscalDecisionRow[]> {
	const conditions = [];

	if (filters?.bodySlug) {
		conditions.push(eq(schema.governingBodies.slug, filters.bodySlug));
	}
	if (filters?.category) {
		conditions.push(
			eq(schema.fiscalDecisions.budgetCategory, filters.category),
		);
	}
	if (filters?.period) {
		conditions.push(
			sql`substr(${schema.meetings.date}, 1, 7) = ${filters.period}`,
		);
	}

	const rows = await db
		.select({
			title: schema.fiscalDecisions.title,
			amount: schema.fiscalDecisions.amount,
			budgetCategory: schema.fiscalDecisions.budgetCategory,
			status: schema.fiscalDecisions.status,
			bodyName: schema.governingBodies.name,
			bodySlug: schema.governingBodies.slug,
			date: schema.meetings.date,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.innerJoin(
			schema.governingBodies,
			eq(schema.meetings.bodyId, schema.governingBodies.id),
		)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(schema.fiscalDecisions.amount))
		.all();

	return rows.map((r) => ({
		title: r.title,
		amount: r.amount,
		budgetCategory: r.budgetCategory ?? "Uncategorized",
		status: parseFiscalStatus(r.status),
		bodyName: r.bodyName,
		bodySlug: r.bodySlug,
		date: r.date,
	}));
}

/**
 * Lists all governing bodies (for the filter dropdown).
 */
export async function listGoverningBodiesQuery(
	db: LibSQLDatabase<typeof schema>,
): Promise<GoverningBodySummary[]> {
	const rows = await db
		.select({
			name: schema.governingBodies.name,
			slug: schema.governingBodies.slug,
			type: schema.governingBodies.type,
		})
		.from(schema.governingBodies)
		.orderBy(schema.governingBodies.name)
		.all();

	return rows.map((r) => ({ ...r, type: r.type as BodyType }));
}

export type FiscalDecisionDetail = {
	title: string;
	description: string;
	amount: number;
	originalAmount: string;
	budgetCategory: string | null;
	status: FiscalStatus;
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
	meetingType: MeetingType;
	bodyName: string;
	bodySlug: string;
	documents: Array<{
		sourceUrl: string;
		rawText: string;
		documentType: "agenda" | "minutes" | "ordinance";
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
export async function getMeetingByBodyAndDateQuery(
	db: LibSQLDatabase<typeof schema>,
	slug: string,
	date: string,
): Promise<MeetingDetail | null> {
	const body = await db
		.select()
		.from(schema.governingBodies)
		.where(eq(schema.governingBodies.slug, slug))
		.get();

	if (!body) return null;

	const meeting = await db
		.select()
		.from(schema.meetings)
		.where(
			and(eq(schema.meetings.bodyId, body.id), eq(schema.meetings.date, date)),
		)
		.get();

	if (!meeting) return null;

	const docs = await db
		.select()
		.from(schema.documents)
		.where(eq(schema.documents.meetingId, meeting.id))
		.all();

	const summary = await db
		.select()
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meeting.id))
		.get();

	if (!summary) return null;

	const fiscals = await db
		.select()
		.from(schema.fiscalDecisions)
		.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
		.all();

	const discussions = await db
		.select()
		.from(schema.budgetDiscussions)
		.where(eq(schema.budgetDiscussions.meetingId, meeting.id))
		.all();

	return {
		id: meeting.id,
		date: meeting.date,
		meetingType: parseMeetingType(meeting.meetingType),
		bodyName: body.name,
		bodySlug: body.slug,
		documents: docs.map((d) => ({
			sourceUrl: d.sourceUrl,
			rawText: d.rawText,
			documentType:
				d.documentType as MeetingDetail["documents"][number]["documentType"],
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
			status: parseFiscalStatus(f.status),
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
