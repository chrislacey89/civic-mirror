import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Context, Effect, Layer } from "effect";
import * as schema from "#/db/schema.ts";
import { DatabaseError } from "#/pipeline/errors.ts";

/**
 * Effect teaching note: Context.Tag creates a typed token that identifies a service
 * in Effect's dependency injection system. The first type parameter is the tag itself
 * (for nominal typing), the second is the service interface it represents.
 * When you `yield* StorageService` inside Effect.gen, Effect knows this computation
 * requires a StorageService in its environment — and won't compile without one.
 */

/**
 * Everything needed to persist one meeting and all its child records.
 * This is the "write shape" — what the pipeline produces after scraping
 * and summarizing, ready to be stored atomically in a single transaction.
 */
type MeetingInput = {
	bodySlug: string;
	date: string;
	meetingType: "regular" | "special" | "workshop";
	documents: Array<{
		sourceUrl: string;
		rawText: string;
		documentType: "agenda" | "minutes" | "ordinance";
	}>;
	summary: {
		highlights: string[];
		prose: string;
		model: string;
	};
	fiscalDecisions: Array<{
		title: string;
		description: string;
		amount: number;
		originalAmount: string;
		budgetCategory?: string;
		status: "approved" | "denied" | "tabled";
		voteRecord?: { yea: number; nay: number; abstain: number };
		vendor?: string;
		fundingSource?: string;
		ordinanceNumber?: string;
		confidence: number;
		isRecurring: boolean;
	}>;
	budgetDiscussions?: Array<{
		topic: string;
		estimatedAmount?: number;
		notes?: string;
	}>;
};

/** Minimal handle returned after a successful store — just enough to reference the meeting. */
type Meeting = { id: number; date: string; bodyId: number };

/**
 * The "read shape" — a fully assembled meeting with all related records
 * joined together. This is what the server function returns to the UI.
 */
type MeetingDetail = {
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
	fiscalDecisions: Array<{
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
	}>;
	budgetDiscussions: Array<{
		topic: string;
		estimatedAmount: number | null;
		notes: string | null;
	}>;
};

/**
 * The contract that StorageService consumers depend on.
 *
 * Effect teaching note: Notice the return types are Effect values, not Promises.
 * `Effect.Effect<Meeting, DatabaseError>` means "a computation that produces a
 * Meeting on success, or a DatabaseError on failure." The third type parameter
 * (requirements) is omitted here — it defaults to `never`, meaning these
 * methods have no additional service dependencies of their own.
 */
interface StorageServiceInterface {
	/** Persist a full meeting and all child records in a single transaction. */
	storeMeeting(input: MeetingInput): Effect.Effect<Meeting, DatabaseError>;
	/** Look up a meeting by governing body slug + ISO date. Returns null if not found. */
	getMeetingByBodyAndDate(
		slug: string,
		date: string,
	): Effect.Effect<MeetingDetail | null, DatabaseError>;
}

class StorageService extends Context.Tag("StorageService")<
	StorageService,
	StorageServiceInterface
>() {}

/**
 * Effect teaching note: Layer.succeed creates a Layer that provides a service
 * implementation. Here we take a Drizzle db instance as a closure parameter,
 * keeping the Effect service decoupled from how the database is constructed.
 * This makes testing trivial — pass an in-memory SQLite db in tests, the real
 * db file in production.
 */
/**
 * Constructs the live (real database) implementation of StorageService.
 *
 * Effect teaching note — Layer.succeed vs Layer.effect:
 *   - `Layer.succeed` provides a value directly — used when construction can't fail.
 *   - `Layer.effect` provides via an Effect — used when construction itself may fail
 *     (e.g. opening a DB connection that might be refused).
 *
 * Here we use `Layer.succeed` because the `db` handle is already open (passed in
 * as a closure parameter). Each method wraps its work in `Effect.try`, which
 * catches synchronous exceptions and maps them to typed `DatabaseError` values.
 *
 * @param db - An open Drizzle database handle. In tests this is `:memory:` SQLite;
 *             in production it's the file-backed database.
 */
function StorageServiceLive(db: BetterSQLite3Database<typeof schema>) {
	return Layer.succeed(StorageService, {
		storeMeeting: (input) =>
			Effect.try({
				try: () => storeMeetingTransaction(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "storeMeeting",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMeetingByBodyAndDate: (slug, date) =>
			Effect.try({
				try: () => getMeetingByBodyAndDateQuery(db, slug, date),
				catch: (error) =>
					new DatabaseError({
						operation: "getMeetingByBodyAndDate",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

/**
 * Effect teaching note: We use a plain synchronous function for the transaction
 * body because better-sqlite3 transactions are synchronous. Effect.tryPromise
 * wraps this at the boundary, converting thrown exceptions into typed
 * DatabaseError values that propagate through the Effect error channel.
 *
 * Key invariant: A meeting must never exist with a summary but without its
 * source text. The transaction ensures all-or-nothing writes.
 */
function storeMeetingTransaction(
	db: BetterSQLite3Database<typeof schema>,
	input: MeetingInput,
): Meeting {
	return db.transaction((tx) => {
		// Resolve governing body by slug
		const body = tx
			.select()
			.from(schema.governingBodies)
			.where(eq(schema.governingBodies.slug, input.bodySlug))
			.get();

		if (!body) {
			throw new Error(`Governing body not found: ${input.bodySlug}`);
		}

		// Insert meeting
		const meeting = tx
			.insert(schema.meetings)
			.values({
				bodyId: body.id,
				date: input.date,
				meetingType: input.meetingType,
			})
			.returning()
			.get();

		// Insert documents
		for (const doc of input.documents) {
			tx.insert(schema.documents)
				.values({
					meetingId: meeting.id,
					sourceUrl: doc.sourceUrl,
					rawText: doc.rawText,
					documentType: doc.documentType,
				})
				.run();
		}

		// Insert summary
		tx.insert(schema.summaries)
			.values({
				meetingId: meeting.id,
				highlights: input.summary.highlights,
				prose: input.summary.prose,
				model: input.summary.model,
			})
			.run();

		// Insert fiscal decisions
		for (const fd of input.fiscalDecisions) {
			tx.insert(schema.fiscalDecisions)
				.values({
					meetingId: meeting.id,
					title: fd.title,
					description: fd.description,
					amount: fd.amount,
					originalAmount: fd.originalAmount,
					budgetCategory: fd.budgetCategory,
					status: fd.status,
					voteRecord: fd.voteRecord,
					vendor: fd.vendor,
					fundingSource: fd.fundingSource,
					ordinanceNumber: fd.ordinanceNumber,
					confidence: fd.confidence,
					isRecurring: fd.isRecurring,
				})
				.run();
		}

		// Insert budget discussions
		if (input.budgetDiscussions) {
			for (const bd of input.budgetDiscussions) {
				tx.insert(schema.budgetDiscussions)
					.values({
						meetingId: meeting.id,
						topic: bd.topic,
						estimatedAmount: bd.estimatedAmount,
						notes: bd.notes,
					})
					.run();
			}
		}

		return { id: meeting.id, date: meeting.date, bodyId: meeting.bodyId };
	});
}

/**
 * Read-side query that assembles the full meeting detail from multiple tables.
 * Uses individual queries rather than a single JOIN for readability and because
 * SQLite's query planner handles simple primary-key lookups efficiently.
 *
 * Returns `null` at the first missing piece (no body, no meeting, no summary)
 * rather than returning partial data.
 */
function getMeetingByBodyAndDateQuery(
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

export { StorageService, StorageServiceLive };
export type { MeetingInput, Meeting, MeetingDetail };
