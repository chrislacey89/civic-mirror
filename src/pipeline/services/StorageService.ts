import { desc, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { Context, Effect, Layer } from "effect";
import type { MeetingDetail } from "#/db/queries.ts";
import { getMeetingByBodyAndDateQuery } from "#/db/queries.ts";
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
type ExtractionMethod = "text-layer" | "ocr" | "unreadable";

type MeetingInput = {
	bodySlug: string;
	date: string;
	meetingType: "regular" | "special" | "workshop";
	documents: Array<{
		sourceUrl: string;
		rawText: string;
		documentType: "agenda" | "minutes" | "ordinance";
		extractionMethod: ExtractionMethod;
	}>;
	/**
	 * Optional — omitted when every document for this meeting is `unreadable`.
	 * In that case the meeting row + document rows are still persisted so the
	 * meeting appears in listings with a link to the source PDF, but nothing
	 * is written to `summaries`, `fiscal_decisions`, or `budget_discussions`.
	 */
	summary?: {
		highlights: string[];
		prose: string;
		model: string;
	};
	fiscalDecisions?: Array<{
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

/**
 * Multiplier applied to `confidence` on fiscal decisions whose source meeting
 * has at least one OCR-extracted document. OCR typically sits at 3–8% WER on
 * clean printed scans and 10–20% on degraded ones, which can subtly corrupt
 * dollar figures in ways the LLM can't detect. Lowering the default confidence
 * lets the existing confidence-aware UI surface that uncertainty without
 * adding OCR-specific rendering paths downstream of the fiscal-decision row.
 */
const OCR_CONFIDENCE_MULTIPLIER = 0.75;

type TranscriptInput = {
	meetingId: number;
	source: "captions" | "whisper";
	rawText: string;
	segments?: Array<{ text: string; startMs: number; durationMs: number }>;
	sourceUrl?: string;
};

/** Minimal handle returned after a successful store — just enough to reference the meeting. */
type Meeting = { id: number; date: string; bodyId: number };

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
	storeTranscript(input: TranscriptInput): Effect.Effect<void, DatabaseError>;
	/**
	 * Returns the ISO date of the most recent meeting for the body, or null if
	 * the body has no meetings yet (or doesn't exist). Used by the orchestrator
	 * to detect the 30-day zero-results anomaly.
	 */
	getMostRecentMeetingDate(
		slug: string,
	): Effect.Effect<string | null, DatabaseError>;
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
 * as a closure parameter). Each method wraps its work in `Effect.tryPromise`, which
 * catches async exceptions and maps them to typed `DatabaseError` values.
 *
 * @param db - An open Drizzle database handle. In tests this is `:memory:` SQLite;
 *             in production it's the Turso-backed database.
 */
function StorageServiceLive(db: LibSQLDatabase<typeof schema>) {
	return Layer.succeed(StorageService, {
		storeMeeting: (input) =>
			Effect.tryPromise({
				try: () => storeMeetingTransaction(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "storeMeeting",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMeetingByBodyAndDate: (slug, date) =>
			Effect.tryPromise({
				try: () => getMeetingByBodyAndDateQuery(db, slug, date),
				catch: (error) =>
					new DatabaseError({
						operation: "getMeetingByBodyAndDate",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		storeTranscript: (input) =>
			Effect.tryPromise({
				try: async () => {
					await db
						.insert(schema.transcripts)
						.values({
							meetingId: input.meetingId,
							source: input.source,
							rawText: input.rawText,
							segments: input.segments,
							sourceUrl: input.sourceUrl,
						})
						.run();
				},
				catch: (error) =>
					new DatabaseError({
						operation: "storeTranscript",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMostRecentMeetingDate: (slug) =>
			Effect.tryPromise({
				try: async () => {
					const row = await db
						.select({ date: schema.meetings.date })
						.from(schema.meetings)
						.innerJoin(
							schema.governingBodies,
							eq(schema.meetings.bodyId, schema.governingBodies.id),
						)
						.where(eq(schema.governingBodies.slug, slug))
						.orderBy(desc(schema.meetings.date))
						.limit(1)
						.get();
					return row?.date ?? null;
				},
				catch: (error) =>
					new DatabaseError({
						operation: "getMostRecentMeetingDate",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

/**
 * Effect teaching note: The transaction body is now async because libsql
 * (Turso) uses an async driver. Drizzle's transaction API handles this
 * transparently — the callback receives an async transaction handle.
 *
 * Key invariant: A meeting must never exist with a summary but without its
 * source text. The transaction ensures all-or-nothing writes.
 */
async function storeMeetingTransaction(
	db: LibSQLDatabase<typeof schema>,
	input: MeetingInput,
): Promise<Meeting> {
	// Silent-degradation guard, enforced at the storage boundary. The composite
	// extractor returns `method: 'unreadable'` for empty outcomes; anything
	// claiming `text-layer` or `ocr` must carry non-empty text. This assertion
	// catches upstream drift (a new path that forgets to map its empty case to
	// 'unreadable') before the row hits the database and turns into invisible
	// bad data. See docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md.
	for (const doc of input.documents) {
		if (doc.extractionMethod !== "unreadable" && doc.rawText.trim() === "") {
			throw new Error(
				`StorageService invariant violated: document sourceUrl=${doc.sourceUrl} ` +
					`has extractionMethod='${doc.extractionMethod}' but empty rawText. ` +
					`Empty text must be tagged as 'unreadable'.`,
			);
		}
	}

	const hasOcrSource = input.documents.some(
		(d) => d.extractionMethod === "ocr",
	);

	return await db.transaction(async (tx) => {
		// Resolve governing body by slug
		const body = await tx
			.select()
			.from(schema.governingBodies)
			.where(eq(schema.governingBodies.slug, input.bodySlug))
			.get();

		if (!body) {
			throw new Error(`Governing body not found: ${input.bodySlug}`);
		}

		// Insert meeting
		const meeting = await tx
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
			await tx
				.insert(schema.documents)
				.values({
					meetingId: meeting.id,
					sourceUrl: doc.sourceUrl,
					rawText: doc.rawText,
					documentType: doc.documentType,
					extractionMethod: doc.extractionMethod,
				})
				.run();
		}

		// Insert summary — skipped when all documents were unreadable.
		if (input.summary) {
			await tx
				.insert(schema.summaries)
				.values({
					meetingId: meeting.id,
					highlights: input.summary.highlights,
					prose: input.summary.prose,
					model: input.summary.model,
				})
				.run();
		}

		// Insert fiscal decisions. When any source document was OCR, we lower
		// the default confidence so the existing confidence-aware UI conveys
		// the extra uncertainty without needing an OCR-aware branch of its own.
		if (input.fiscalDecisions) {
			for (const fd of input.fiscalDecisions) {
				const confidence = hasOcrSource
					? fd.confidence * OCR_CONFIDENCE_MULTIPLIER
					: fd.confidence;
				await tx
					.insert(schema.fiscalDecisions)
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
						confidence,
						isRecurring: fd.isRecurring,
					})
					.run();
			}
		}

		// Insert budget discussions
		if (input.budgetDiscussions) {
			for (const bd of input.budgetDiscussions) {
				await tx
					.insert(schema.budgetDiscussions)
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

export { StorageService, StorageServiceLive, OCR_CONFIDENCE_MULTIPLIER };
export type { MeetingInput, Meeting, ExtractionMethod };
