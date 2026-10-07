import { and, desc, eq, sql, sum } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "#/db/schema.ts";
import type { SourceDisagreement, SourceKind } from "#/pipeline/sources.ts";

export type MeetingType = "regular" | "special" | "workshop";
export type FiscalStatus = "approved" | "denied" | "tabled";
export type BodyType = "town" | "county" | "school";
export type ExtractionMethod = "text-layer" | "ocr" | "unreadable";

const EXTRACTION_METHODS = new Set<string>(["text-layer", "ocr", "unreadable"]);

function parseExtractionMethod(raw: string): ExtractionMethod {
	if (EXTRACTION_METHODS.has(raw)) return raw as ExtractionMethod;
	throw new Error(`Invalid extraction method: ${raw}`);
}

/**
 * Derive meeting-level extraction method from per-document methods.
 * "unreadable" only if there is nothing to show: every document is unreadable
 * (or there are none) and no summary exists. A meeting with a summary but no
 * readable document (e.g. one built from the video alone) is "text-layer";
 * otherwise "ocr" if any readable doc came through OCR, else "text-layer".
 */
function deriveMeetingExtractionMethod(
	methods: ExtractionMethod[],
	hasSummary: boolean,
): ExtractionMethod {
	if (methods.every((m) => m === "unreadable")) {
		return hasSummary ? "text-layer" : "unreadable";
	}
	if (methods.some((m) => m === "ocr")) return "ocr";
	return "text-layer";
}

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
	session: string;
	meetingType: MeetingType;
	bodyName: string;
	bodySlug: string;
	extractionMethod: ExtractionMethod;
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
	session: string;
};

export type GoverningBodySummary = {
	name: string;
	slug: string;
	type: BodyType;
};

export type BodyWithStats = {
	name: string;
	slug: string;
	type: BodyType;
	meetingCount: number;
	totalSpending: number;
	decisionCount: number;
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

		const docs = await db
			.select()
			.from(schema.documents)
			.where(eq(schema.documents.meetingId, m.id))
			.all();

		const summary = await db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, m.id))
			.get();

		const extractionMethod = deriveMeetingExtractionMethod(
			docs.map((d) => parseExtractionMethod(d.extractionMethod)),
			summary !== undefined,
		);

		// Readable meetings without a summary are a broken mid-pipeline state —
		// skip them. Unreadable meetings legitimately have no summary and must
		// surface so citizens can reach the detail page + source PDF link.
		if (!summary && extractionMethod !== "unreadable") continue;

		const fiscals = await db
			.select()
			.from(schema.fiscalDecisions)
			.where(eq(schema.fiscalDecisions.meetingId, m.id))
			.all();

		result.push({
			id: m.id,
			date: m.date,
			session: m.session,
			meetingType: parseMeetingType(m.meetingType),
			bodyName: body.name,
			bodySlug: body.slug,
			extractionMethod,
			highlights: (summary?.highlights as string[] | undefined) ?? [],
			prose: summary?.prose ?? "",
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
			session: schema.meetings.session,
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
		session: r.session,
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

/**
 * Lists all governing bodies with aggregated meeting and spending stats.
 *
 * Uses three GROUP BY queries (bodies, meeting counts, fiscal aggregates) and
 * stitches them together in memory rather than a per-body loop. Avoids the
 * row-explosion that would happen if we LEFT JOINed both meetings and
 * fiscal_decisions into a single query.
 */
export async function listBodiesWithStatsQuery(
	db: LibSQLDatabase<typeof schema>,
): Promise<BodyWithStats[]> {
	const bodies = await db
		.select()
		.from(schema.governingBodies)
		.orderBy(schema.governingBodies.name)
		.all();

	const meetingCounts = await db
		.select({
			bodyId: schema.meetings.bodyId,
			count: sql<number>`count(*)`,
		})
		.from(schema.meetings)
		.groupBy(schema.meetings.bodyId)
		.all();

	const fiscalAggs = await db
		.select({
			bodyId: schema.meetings.bodyId,
			total: sum(schema.fiscalDecisions.amount),
			count: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.groupBy(schema.meetings.bodyId)
		.all();

	const meetingsByBody = new Map(meetingCounts.map((r) => [r.bodyId, r.count]));
	const fiscalsByBody = new Map(
		fiscalAggs.map((r) => [
			r.bodyId,
			{ total: Number(r.total) || 0, count: r.count },
		]),
	);

	return bodies.map((body) => ({
		name: body.name,
		slug: body.slug,
		type: body.type as BodyType,
		meetingCount: meetingsByBody.get(body.id) ?? 0,
		totalSpending: fiscalsByBody.get(body.id)?.total ?? 0,
		decisionCount: fiscalsByBody.get(body.id)?.count ?? 0,
	}));
}

/**
 * Single-body variant of listBodiesWithStatsQuery — scoped to one body slug
 * so the body profile page doesn't load the full bodies table to validate
 * one slug. Returns null if the slug doesn't match an existing body.
 */
export async function getBodyWithStatsBySlugQuery(
	db: LibSQLDatabase<typeof schema>,
	bodySlug: string,
): Promise<BodyWithStats | null> {
	const body = await db
		.select()
		.from(schema.governingBodies)
		.where(eq(schema.governingBodies.slug, bodySlug))
		.get();

	if (!body) return null;

	const meetingCount = await db
		.select({ count: sql<number>`count(*)` })
		.from(schema.meetings)
		.where(eq(schema.meetings.bodyId, body.id))
		.get();

	const fiscalAgg = await db
		.select({
			total: sum(schema.fiscalDecisions.amount),
			count: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.where(eq(schema.meetings.bodyId, body.id))
		.get();

	return {
		name: body.name,
		slug: body.slug,
		type: body.type as BodyType,
		meetingCount: meetingCount?.count ?? 0,
		totalSpending: Number(fiscalAgg?.total) || 0,
		decisionCount: fiscalAgg?.count ?? 0,
	};
}

/**
 * Aggregates fiscal decisions by budget category for a single governing body.
 */
export async function aggregateFiscalByCategoryForBodyQuery(
	db: LibSQLDatabase<typeof schema>,
	bodySlug: string,
): Promise<FiscalByCategory[]> {
	const body = await db
		.select()
		.from(schema.governingBodies)
		.where(eq(schema.governingBodies.slug, bodySlug))
		.get();

	if (!body) return [];

	const rows = await db
		.select({
			budgetCategory: schema.fiscalDecisions.budgetCategory,
			totalAmount: sum(schema.fiscalDecisions.amount),
			decisionCount: sql<number>`count(${schema.fiscalDecisions.id})`,
		})
		.from(schema.fiscalDecisions)
		.innerJoin(
			schema.meetings,
			eq(schema.fiscalDecisions.meetingId, schema.meetings.id),
		)
		.where(eq(schema.meetings.bodyId, body.id))
		.groupBy(schema.fiscalDecisions.budgetCategory)
		.orderBy(desc(sum(schema.fiscalDecisions.amount)))
		.all();

	return rows.map((r) => ({
		budgetCategory: r.budgetCategory ?? "Uncategorized",
		totalAmount: Number(r.totalAmount) || 0,
		decisionCount: r.decisionCount,
	}));
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
 * What a meeting's summary was built from. Only a summary built from the video
 * carries a video link, and that link is null when the transcript recorded no
 * URL. `none` is a meeting with no summary, or one with nothing attached.
 */
export type SummarySources =
	| { origin: "none" }
	| { origin: "documents" }
	| { origin: "video"; videoUrl: string | null }
	| { origin: "both"; videoUrl: string | null };

/**
 * The "read shape" — a fully assembled meeting with all related records
 * joined together. This is what the server function returns to the UI.
 */
export type MeetingDetail = {
	id: number;
	date: string;
	/** Which of the body's meetings on `date` this is; empty when there is one. */
	session: string;
	meetingType: MeetingType;
	bodyName: string;
	bodySlug: string;
	extractionMethod: ExtractionMethod;
	documents: Array<{
		sourceUrl: string;
		rawText: string;
		documentType: "agenda" | "minutes" | "ordinance";
		extractionMethod: ExtractionMethod;
	}>;
	summary: { highlights: string[]; prose: string; model: string } | null;
	/** What the summary was built from. */
	summarySources: SummarySources;
	/** Points where the documents and the video state different things. */
	sourceDisagreements: readonly SourceDisagreement[];
	fiscalDecisions: Array<FiscalDecisionDetail>;
	budgetDiscussions: Array<{
		topic: string;
		estimatedAmount: number | null;
		notes: string | null;
	}>;
};

/**
 * The kinds a summary was built from. A summary that recorded none has had no
 * source of the other kind attached since it was built, because the pipeline
 * stamps the kinds before any such attach (`stampSummaryFingerprint`). So it
 * was built from the documents when the meeting has any, and from the
 * transcript only when it has none.
 */
function summarySourceKinds(
	stored: SourceKind[],
	attached: { hasDocuments: boolean; hasTranscript: boolean },
): SourceKind[] {
	if (stored.length > 0) return stored;
	if (attached.hasDocuments) return ["documents"];
	if (attached.hasTranscript) return ["transcript"];
	return [];
}

/**
 * The one place that decides what a summary was built from. `videoUrl` is the
 * meeting's transcript link, and reaches the result only when the video is one
 * of the summary's sources.
 */
function summarySourcesOf(
	kinds: readonly SourceKind[],
	videoUrl: string | null,
): SummarySources {
	const fromVideo = kinds.includes("transcript");
	const fromDocuments = kinds.includes("documents");
	if (fromVideo && fromDocuments) return { origin: "both", videoUrl };
	if (fromVideo) return { origin: "video", videoUrl };
	if (fromDocuments) return { origin: "documents" };
	return { origin: "none" };
}

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
	session?: string,
): Promise<MeetingDetail | null> {
	const body = await db
		.select()
		.from(schema.governingBodies)
		.where(eq(schema.governingBodies.slug, slug))
		.get();

	if (!body) return null;

	// With no session named, a date that holds one meeting resolves to it, so
	// the plain /meetings/<body>/<date> URL keeps working. On a date with
	// several, the empty session wins, then the earliest stored (lowest id).
	const meeting = await db
		.select()
		.from(schema.meetings)
		.where(
			and(
				eq(schema.meetings.bodyId, body.id),
				eq(schema.meetings.date, date),
				session === undefined
					? undefined
					: eq(schema.meetings.session, session),
			),
		)
		.orderBy(desc(sql`${schema.meetings.session} = ''`), schema.meetings.id)
		.get();

	if (!meeting) return null;

	const docs = await db
		.select()
		.from(schema.documents)
		.where(eq(schema.documents.meetingId, meeting.id))
		.all();

	const docMethods = docs.map((d) => parseExtractionMethod(d.extractionMethod));

	const summary = await db
		.select()
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meeting.id))
		.get();

	const extractionMethod = deriveMeetingExtractionMethod(
		docMethods,
		summary !== undefined,
	);

	if (!summary && extractionMethod !== "unreadable") return null;

	// Only the link is read: transcript text never leaves the server.
	const transcriptLinks = await db
		.select({ sourceUrl: schema.transcripts.sourceUrl })
		.from(schema.transcripts)
		.where(eq(schema.transcripts.meetingId, meeting.id))
		.all();

	const sourceKinds = summary
		? summarySourceKinds(summary.sourceKinds, {
				hasDocuments: docs.length > 0,
				hasTranscript: transcriptLinks.length > 0,
			})
		: [];
	const summarySources = summarySourcesOf(
		sourceKinds,
		transcriptLinks.find((t) => t.sourceUrl)?.sourceUrl ?? null,
	);

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
		session: meeting.session,
		meetingType: parseMeetingType(meeting.meetingType),
		bodyName: body.name,
		bodySlug: body.slug,
		extractionMethod,
		documents: docs.map((d, i) => ({
			sourceUrl: d.sourceUrl,
			rawText: d.rawText,
			documentType:
				d.documentType as MeetingDetail["documents"][number]["documentType"],
			extractionMethod: docMethods[i],
		})),
		summary: summary
			? {
					highlights: summary.highlights as string[],
					prose: summary.prose,
					model: summary.model,
				}
			: null,
		summarySources,
		sourceDisagreements: summary?.sourceDisagreements ?? [],
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
