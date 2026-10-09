import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { Context, Effect, Layer } from "effect";
import type { MeetingDetail } from "#/db/queries.ts";
import { getMeetingByBodyAndDateQuery } from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";
import {
	DRAMA_CATEGORIES,
	type DramaLevel,
	mapSumToLevel,
	type ScoredDramaCategory,
} from "#/lib/drama-levels.ts";
import { DatabaseError } from "#/pipeline/errors.ts";
import type { HeldReason } from "#/pipeline/held.ts";
import type { MatchableSummary } from "#/pipeline/services/MeetingMatchService.ts";
import type {
	TranscriptResult,
	TranscriptSegment,
} from "#/pipeline/services/TranscriptionService.ts";
import type {
	SourceDisagreement,
	SourceKind,
	UnfingerprintedSummarySources,
} from "#/pipeline/sources.ts";
import { stampOfUnfingerprintedSummary } from "#/pipeline/sources.ts";

/**
 * Effect teaching note: Context.Service creates a typed token that identifies a service
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
	/**
	 * Which of the body's meetings on `date` this is. Omit it for a source
	 * whose rows are single documents of one meeting; calls that share a date
	 * and a session are stored as one meeting.
	 */
	session?: string;
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
		/** Which kinds of source the summary was built from. */
		sourceKinds?: SourceKind[];
		/** `computeSourceFingerprint` of the source URLs the summary was built from. */
		sourceFingerprint?: string;
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

/** Which sources a stored meeting holds, and which its summary was built from. */
type MeetingSourceState = {
	meetingId: number;
	date: string;
	session: string;
	hasDocuments: boolean;
	transcriptSourceUrl: string | null;
	/** Empty for a summary with no recorded sources, and for a meeting with no summary. */
	summarySourceKinds: SourceKind[];
};

/** A video to hold. The last three fields come from the same-meeting check. */
type HeldVideoInput = {
	bodySlug: string;
	videoId: string;
	title: string;
	/** Null when the title has no readable date. */
	meetingDate: string | null;
	reason: HeldReason;
	probability?: number;
	sharedIdentifiers?: number;
	candidateMeetingId?: number;
};

type HeldVideo = HeldVideoInput & { createdAt: Date | null };

/** Every source a stored meeting holds, and what its current summary was built from. */
type MeetingSources = {
	documents: {
		sourceUrl: string;
		rawText: string;
		documentType: string;
		extractionMethod: string;
	}[];
	transcript: { sourceUrl: string | null; rawText: string } | null;
	summary: { sourceKinds: SourceKind[]; sourceFingerprint: string } | null;
};

/**
 * Which of a body's summaries a listing takes: `combined` for those built
 * from both documents and a transcript, `all` for every one.
 */
type SummaryScope = "combined" | "all";

/** Transaction handle Drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<
	Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]
>[0];

/** Minimal handle returned after a successful store — just enough to reference the meeting. */
type Meeting = { id: number; date: string; bodyId: number };

type DramaCategoryScoreInput = {
	score: number;
	evidenceQuotes: string[];
};

type StoreDramaAssessmentInput = {
	meetingId: number;
	level: DramaLevel;
	confidence: number;
	promptVersion: string;
	model: string;
	headline: string;
	narrative: string;
	categoryScores: Record<ScoredDramaCategory, DramaCategoryScoreInput>;
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
	storeTranscript(input: TranscriptInput): Effect.Effect<void, DatabaseError>;
	/**
	 * Returns the ISO date of the most recent meeting for the body, or null if
	 * the body has no meetings yet (or doesn't exist). Used by the orchestrator
	 * to detect the 30-day zero-results anomaly.
	 */
	getMostRecentMeetingDate(
		slug: string,
	): Effect.Effect<string | null, DatabaseError>;
	/**
	 * Persist a drama assessment + its seven per-category score rows atomically.
	 *
	 * Idempotent on the (meetingId, promptVersion, model) natural key: if a
	 * row already exists for that tuple, this is a no-op.
	 *
	 * Storage-boundary invariant: `level` must equal
	 * `mapSumToLevel(sum(categoryScores.*.score))`. On mismatch the computed
	 * level wins and the override is logged — math is the source of truth,
	 * the LLM does not get the last word.
	 *
	 * Auto-publish rule (v1, hardcoded): off-the-rails lands with
	 * `publishedAt = null` and stays invisible to the public site until
	 * operator review. Routine/bumpy/heated auto-publish at insert time.
	 */
	storeDramaAssessment(
		input: StoreDramaAssessmentInput,
	): Effect.Effect<void, DatabaseError>;
	/**
	 * The sources held by the body's meeting on `date` under `session`, or
	 * null when there is no such meeting. The session is matched exactly: ""
	 * finds only the meeting stored without one.
	 */
	getMeetingSourceState(input: {
		bodySlug: string;
		date: string;
		session: string;
	}): Effect.Effect<MeetingSourceState | null, DatabaseError>;
	/**
	 * Meetings of the body within `windowDays` of `date` (excluding `date`
	 * itself), under the same session, that have documents and no transcript.
	 * Nearest date first.
	 */
	findNearbyDocumentOnlyMeetings(input: {
		bodySlug: string;
		date: string; // ISO YYYY-MM-DD
		session: string;
		windowDays: number;
	}): Effect.Effect<MeetingSourceState[], DatabaseError>;
	/** The stored summary of a meeting in the shape the same-meeting check takes, or null when it has none. */
	getMatchableSummary(
		meetingId: number,
	): Effect.Effect<MatchableSummary | null, DatabaseError>;
	/** True when a stored transcript, on any meeting, came from `sourceUrl`. */
	hasTranscriptForVideo(
		sourceUrl: string,
	): Effect.Effect<boolean, DatabaseError>;
	/**
	 * The stored transcript that came from `sourceUrl` and the meeting holding
	 * it, when that meeting has no drama assessment under any prompt version
	 * or model. Null when no transcript came from `sourceUrl`, and when its
	 * meeting has an assessment.
	 */
	getUnassessedTranscript(
		sourceUrl: string,
	): Effect.Effect<
		{ meetingId: number; transcript: TranscriptResult } | null,
		DatabaseError
	>;
	/** Insert-if-absent on videoId. created is false when the video was already held. */
	holdVideo(
		input: HeldVideoInput,
	): Effect.Effect<{ created: boolean }, DatabaseError>;
	isVideoHeld(videoId: string): Effect.Effect<boolean, DatabaseError>;
	/** Held videos, oldest first; one body's when `bodySlug` is given. */
	listHeldVideos(input?: {
		bodySlug?: string;
	}): Effect.Effect<HeldVideo[], DatabaseError>;
	/**
	 * A body's meetings that have a summary, oldest first; the one on `date`
	 * when it is given. The `combined` scope keeps only a summary built from
	 * both documents and a transcript.
	 */
	listSummaryMeetings(input: {
		bodySlug: string;
		date?: string;
		scope: SummaryScope;
	}): Effect.Effect<{ meetingId: number; date: string }[], DatabaseError>;
	/**
	 * Every document and the first transcript a meeting holds, plus the source
	 * kinds and fingerprint of its summary. A meeting id with no rows yields no
	 * documents, no transcript and no summary.
	 */
	getMeetingSources(
		meetingId: number,
	): Effect.Effect<MeetingSources, DatabaseError>;
	/**
	 * Swap a meeting's summary, fiscal decisions and budget discussions for a
	 * new set in one transaction, so a failed insert leaves the old set intact.
	 * Works when the meeting has no summary yet. Documents, transcripts, drama
	 * rows and the meeting itself are not touched.
	 */
	replaceMeetingSummary(input: {
		meetingId: number;
		summary: { highlights: string[]; prose: string; model: string };
		fiscalDecisions: MeetingInput["fiscalDecisions"];
		budgetDiscussions: MeetingInput["budgetDiscussions"];
		sourceKinds: SourceKind[];
		sourceFingerprint: string;
		sourceDisagreements: SourceDisagreement[];
	}): Effect.Effect<void, DatabaseError>;
	/**
	 * Delete a meeting's transcript rows and its drama assessments, with their
	 * category scores, in one transaction. Returns the detached video URL, or
	 * null when the meeting had no transcript. Documents, the summary and the
	 * meeting itself are not touched.
	 */
	detachTranscript(
		meetingId: number,
	): Effect.Effect<{ sourceUrl: string | null } | null, DatabaseError>;
	/**
	 * Delete the one document a meeting holds under this source URL. Returns
	 * whether a row was deleted. The summary and everything derived from it are
	 * not touched, so they still describe the document until the summary is
	 * regenerated.
	 */
	detachDocument(input: {
		meetingId: number;
		sourceUrl: string;
	}): Effect.Effect<boolean, DatabaseError>;
	/**
	 * Record what a summary stored without a fingerprint was built from: the
	 * fingerprint of those sources and the one kind it read, in one update. A
	 * summary that already has a fingerprint, and a meeting with no summary,
	 * are left as they are. Nothing else is touched.
	 */
	stampSummarySources(input: {
		meetingId: number;
		builtFrom: UnfingerprintedSummarySources;
	}): Effect.Effect<void, DatabaseError>;
}

class StorageService extends Context.Service<
	StorageService,
	StorageServiceInterface
>()("StorageService") {}

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
					// Idempotency guard mirroring storeMeeting — (meetingId, source) is
					// the natural key enforced by the transcripts_meeting_id_source_unique
					// index. Skip the insert when a transcript for this pair already
					// exists so re-runs of the YouTube path don't stack duplicates.
					const existing = await db
						.select({ id: schema.transcripts.id })
						.from(schema.transcripts)
						.where(
							and(
								eq(schema.transcripts.meetingId, input.meetingId),
								eq(schema.transcripts.source, input.source),
							),
						)
						.get();
					if (existing) return;

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
		storeDramaAssessment: (input) =>
			Effect.tryPromise({
				try: () => storeDramaAssessmentTransaction(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "storeDramaAssessment",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMeetingSourceState: (input) =>
			Effect.tryPromise({
				try: () => getMeetingSourceStateQuery(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "getMeetingSourceState",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		findNearbyDocumentOnlyMeetings: (input) =>
			Effect.tryPromise({
				try: () => findNearbyDocumentOnlyMeetingsQuery(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "findNearbyDocumentOnlyMeetings",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMatchableSummary: (meetingId) =>
			Effect.tryPromise({
				try: () => getMatchableSummaryQuery(db, meetingId),
				catch: (error) =>
					new DatabaseError({
						operation: "getMatchableSummary",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		hasTranscriptForVideo: (sourceUrl) =>
			Effect.tryPromise({
				try: async () => {
					const row = await db
						.select({ id: schema.transcripts.id })
						.from(schema.transcripts)
						.where(eq(schema.transcripts.sourceUrl, sourceUrl))
						.limit(1)
						.get();
					return row !== undefined;
				},
				catch: (error) =>
					new DatabaseError({
						operation: "hasTranscriptForVideo",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getUnassessedTranscript: (sourceUrl) =>
			Effect.tryPromise({
				try: () => getUnassessedTranscriptQuery(db, sourceUrl),
				catch: (error) =>
					new DatabaseError({
						operation: "getUnassessedTranscript",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		holdVideo: (input) =>
			Effect.tryPromise({
				try: async () => {
					const body = await db
						.select({ id: schema.governingBodies.id })
						.from(schema.governingBodies)
						.where(eq(schema.governingBodies.slug, input.bodySlug))
						.get();
					if (!body) {
						throw new Error(`Governing body not found: ${input.bodySlug}`);
					}
					// The unique index on video_id decides whether this is the
					// first hold, so two runs cannot both see the video as new.
					const inserted = await db
						.insert(schema.heldVideos)
						.values({
							bodyId: body.id,
							videoId: input.videoId,
							title: input.title,
							meetingDate: input.meetingDate,
							reason: input.reason,
							probability: input.probability,
							sharedIdentifiers: input.sharedIdentifiers,
							candidateMeetingId: input.candidateMeetingId,
						})
						.onConflictDoNothing({ target: schema.heldVideos.videoId })
						.returning({ id: schema.heldVideos.id });
					return { created: inserted.length > 0 };
				},
				catch: (error) =>
					new DatabaseError({
						operation: "holdVideo",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		isVideoHeld: (videoId) =>
			Effect.tryPromise({
				try: async () => {
					const row = await db
						.select({ id: schema.heldVideos.id })
						.from(schema.heldVideos)
						.where(eq(schema.heldVideos.videoId, videoId))
						.get();
					return row !== undefined;
				},
				catch: (error) =>
					new DatabaseError({
						operation: "isVideoHeld",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		listHeldVideos: (input) =>
			Effect.tryPromise({
				try: async () => {
					const rows = await db
						.select({
							held: schema.heldVideos,
							bodySlug: schema.governingBodies.slug,
						})
						.from(schema.heldVideos)
						.innerJoin(
							schema.governingBodies,
							eq(schema.heldVideos.bodyId, schema.governingBodies.id),
						)
						.where(
							input?.bodySlug === undefined
								? undefined
								: eq(schema.governingBodies.slug, input.bodySlug),
						)
						.orderBy(schema.heldVideos.id)
						.all();
					return rows.map(({ held, bodySlug }) => ({
						bodySlug,
						videoId: held.videoId,
						title: held.title,
						meetingDate: held.meetingDate,
						reason: held.reason,
						...(held.probability !== null
							? { probability: held.probability }
							: {}),
						...(held.sharedIdentifiers !== null
							? { sharedIdentifiers: held.sharedIdentifiers }
							: {}),
						...(held.candidateMeetingId !== null
							? { candidateMeetingId: held.candidateMeetingId }
							: {}),
						createdAt: held.createdAt,
					}));
				},
				catch: (error) =>
					new DatabaseError({
						operation: "listHeldVideos",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		listSummaryMeetings: (input) =>
			Effect.tryPromise({
				try: async () => {
					const rows = await db
						.select({
							meetingId: schema.meetings.id,
							date: schema.meetings.date,
							sourceKinds: schema.summaries.sourceKinds,
						})
						.from(schema.summaries)
						.innerJoin(
							schema.meetings,
							eq(schema.summaries.meetingId, schema.meetings.id),
						)
						.innerJoin(
							schema.governingBodies,
							eq(schema.meetings.bodyId, schema.governingBodies.id),
						)
						.where(
							and(
								eq(schema.governingBodies.slug, input.bodySlug),
								input.date === undefined
									? undefined
									: eq(schema.meetings.date, input.date),
							),
						)
						.orderBy(schema.meetings.date, schema.meetings.id)
						.all();
					return rows
						.filter(
							(row) =>
								input.scope === "all" ||
								(row.sourceKinds.includes("documents") &&
									row.sourceKinds.includes("transcript")),
						)
						.map(({ meetingId, date }) => ({ meetingId, date }));
				},
				catch: (error) =>
					new DatabaseError({
						operation: "listSummaryMeetings",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		getMeetingSources: (meetingId) =>
			Effect.tryPromise({
				try: () => getMeetingSourcesQuery(db, meetingId),
				catch: (error) =>
					new DatabaseError({
						operation: "getMeetingSources",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		replaceMeetingSummary: (input) =>
			Effect.tryPromise({
				try: () => replaceMeetingSummaryTransaction(db, input),
				catch: (error) =>
					new DatabaseError({
						operation: "replaceMeetingSummary",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		detachTranscript: (meetingId) =>
			Effect.tryPromise({
				try: () => detachTranscriptTransaction(db, meetingId),
				catch: (error) =>
					new DatabaseError({
						operation: "detachTranscript",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		detachDocument: (input) =>
			Effect.tryPromise({
				try: async () => {
					const deleted = await db
						.delete(schema.documents)
						.where(
							and(
								eq(schema.documents.meetingId, input.meetingId),
								eq(schema.documents.sourceUrl, input.sourceUrl),
							),
						)
						.returning({ id: schema.documents.id });
					return deleted.length > 0;
				},
				catch: (error) =>
					new DatabaseError({
						operation: "detachDocument",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		stampSummarySources: (input) =>
			Effect.tryPromise({
				try: async () => {
					await db
						.update(schema.summaries)
						.set(stampOfUnfingerprintedSummary(input.builtFrom))
						.where(
							and(
								eq(schema.summaries.meetingId, input.meetingId),
								eq(schema.summaries.sourceFingerprint, ""),
							),
						)
						.run();
				},
				catch: (error) =>
					new DatabaseError({
						operation: "stampSummarySources",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

async function getMeetingSourceStateQuery(
	db: LibSQLDatabase<typeof schema>,
	input: { bodySlug: string; date: string; session: string },
): Promise<MeetingSourceState | null> {
	const meeting = await db
		.select({
			id: schema.meetings.id,
			date: schema.meetings.date,
			session: schema.meetings.session,
		})
		.from(schema.meetings)
		.innerJoin(
			schema.governingBodies,
			eq(schema.meetings.bodyId, schema.governingBodies.id),
		)
		.where(
			and(
				eq(schema.governingBodies.slug, input.bodySlug),
				eq(schema.meetings.date, input.date),
				eq(schema.meetings.session, input.session),
			),
		)
		.get();
	if (!meeting) return null;
	return sourceStateOfMeeting(db, meeting);
}

async function getUnassessedTranscriptQuery(
	db: LibSQLDatabase<typeof schema>,
	sourceUrl: string,
): Promise<{ meetingId: number; transcript: TranscriptResult } | null> {
	const row = await db
		.select({
			meetingId: schema.transcripts.meetingId,
			source: schema.transcripts.source,
			rawText: schema.transcripts.rawText,
			segments: schema.transcripts.segments,
		})
		.from(schema.transcripts)
		.where(eq(schema.transcripts.sourceUrl, sourceUrl))
		.orderBy(schema.transcripts.id)
		.limit(1)
		.get();
	if (!row) return null;
	const assessment = await db
		.select({ id: schema.dramaAssessments.id })
		.from(schema.dramaAssessments)
		.where(eq(schema.dramaAssessments.meetingId, row.meetingId))
		.limit(1)
		.get();
	if (assessment) return null;
	return {
		meetingId: row.meetingId,
		transcript: {
			source: row.source as TranscriptResult["source"],
			rawText: row.rawText,
			// Stored as given to `storeTranscript`, which takes them optionally.
			segments: (row.segments as TranscriptSegment[] | null) ?? [],
		},
	};
}

async function sourceStateOfMeeting(
	db: LibSQLDatabase<typeof schema>,
	meeting: { id: number; date: string; session: string },
): Promise<MeetingSourceState> {
	const document = await db
		.select({ id: schema.documents.id })
		.from(schema.documents)
		.where(eq(schema.documents.meetingId, meeting.id))
		.limit(1)
		.get();
	const transcript = await db
		.select({ sourceUrl: schema.transcripts.sourceUrl })
		.from(schema.transcripts)
		.where(eq(schema.transcripts.meetingId, meeting.id))
		.orderBy(schema.transcripts.id)
		.limit(1)
		.get();
	const summary = await db
		.select({ sourceKinds: schema.summaries.sourceKinds })
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meeting.id))
		.get();

	return {
		meetingId: meeting.id,
		date: meeting.date,
		session: meeting.session,
		hasDocuments: document !== undefined,
		transcriptSourceUrl: transcript?.sourceUrl ?? null,
		summarySourceKinds: summary?.sourceKinds ?? [],
	};
}

async function findNearbyDocumentOnlyMeetingsQuery(
	db: LibSQLDatabase<typeof schema>,
	input: {
		bodySlug: string;
		date: string;
		session: string;
		windowDays: number;
	},
): Promise<MeetingSourceState[]> {
	const center = new Date(`${input.date}T00:00:00Z`);
	const shifted = (days: number) => {
		const day = new Date(center);
		day.setUTCDate(day.getUTCDate() + days);
		return day.toISOString().slice(0, 10);
	};

	const candidates = await db
		.select({
			id: schema.meetings.id,
			date: schema.meetings.date,
			session: schema.meetings.session,
		})
		.from(schema.meetings)
		.innerJoin(
			schema.governingBodies,
			eq(schema.meetings.bodyId, schema.governingBodies.id),
		)
		.where(
			and(
				eq(schema.governingBodies.slug, input.bodySlug),
				eq(schema.meetings.session, input.session),
				ne(schema.meetings.date, input.date),
				gte(schema.meetings.date, shifted(-input.windowDays)),
				lte(schema.meetings.date, shifted(input.windowDays)),
			),
		)
		.all();

	const distance = (date: string) =>
		Math.abs(new Date(`${date}T00:00:00Z`).getTime() - center.getTime());
	const states: MeetingSourceState[] = [];
	for (const candidate of candidates) {
		const state = await sourceStateOfMeeting(db, candidate);
		if (state.hasDocuments && state.transcriptSourceUrl === null) {
			states.push(state);
		}
	}
	return states.sort(
		(a, b) =>
			distance(a.date) - distance(b.date) || a.date.localeCompare(b.date),
	);
}

async function getMatchableSummaryQuery(
	db: LibSQLDatabase<typeof schema>,
	meetingId: number,
): Promise<MatchableSummary | null> {
	const summary = await db
		.select({
			highlights: schema.summaries.highlights,
			prose: schema.summaries.prose,
		})
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meetingId))
		.get();
	if (!summary) return null;

	const decisions = await db
		.select({
			title: schema.fiscalDecisions.title,
			originalAmount: schema.fiscalDecisions.originalAmount,
			ordinanceNumber: schema.fiscalDecisions.ordinanceNumber,
		})
		.from(schema.fiscalDecisions)
		.where(eq(schema.fiscalDecisions.meetingId, meetingId))
		.orderBy(schema.fiscalDecisions.id)
		.all();

	return {
		highlights: summary.highlights as string[],
		prose: summary.prose,
		fiscalDecisions: decisions.map(
			({ title, originalAmount, ordinanceNumber }) => ({
				title,
				originalAmount,
				...(ordinanceNumber === null ? {} : { ordinanceNumber }),
			}),
		),
	};
}

async function getMeetingSourcesQuery(
	db: LibSQLDatabase<typeof schema>,
	meetingId: number,
): Promise<MeetingSources> {
	const documents = await db
		.select({
			sourceUrl: schema.documents.sourceUrl,
			rawText: schema.documents.rawText,
			documentType: schema.documents.documentType,
			extractionMethod: schema.documents.extractionMethod,
		})
		.from(schema.documents)
		.where(eq(schema.documents.meetingId, meetingId))
		.orderBy(schema.documents.id)
		.all();
	// The first transcript by id, the same one getMeetingSourceStateQuery reports.
	const transcript = await db
		.select({
			sourceUrl: schema.transcripts.sourceUrl,
			rawText: schema.transcripts.rawText,
		})
		.from(schema.transcripts)
		.where(eq(schema.transcripts.meetingId, meetingId))
		.orderBy(schema.transcripts.id)
		.limit(1)
		.get();
	const summary = await db
		.select({
			sourceKinds: schema.summaries.sourceKinds,
			sourceFingerprint: schema.summaries.sourceFingerprint,
		})
		.from(schema.summaries)
		.where(eq(schema.summaries.meetingId, meetingId))
		.get();

	return {
		documents,
		transcript: transcript ?? null,
		summary: summary ?? null,
	};
}

/**
 * Replace a meeting's summary and the fiscal decisions and budget discussions
 * derived from it. Deletes run child-first, matching delete-meeting.ts. The
 * OCR flag is read inside the transaction so it reflects the documents the
 * new rows are written against.
 */
async function replaceMeetingSummaryTransaction(
	db: LibSQLDatabase<typeof schema>,
	input: Parameters<StorageServiceInterface["replaceMeetingSummary"]>[0],
): Promise<void> {
	await db.transaction(async (tx) => {
		const ocrDocument = await tx
			.select({ id: schema.documents.id })
			.from(schema.documents)
			.where(
				and(
					eq(schema.documents.meetingId, input.meetingId),
					eq(schema.documents.extractionMethod, "ocr"),
				),
			)
			.limit(1)
			.get();

		await tx
			.delete(schema.budgetDiscussions)
			.where(eq(schema.budgetDiscussions.meetingId, input.meetingId))
			.run();
		await tx
			.delete(schema.fiscalDecisions)
			.where(eq(schema.fiscalDecisions.meetingId, input.meetingId))
			.run();
		await tx
			.delete(schema.summaries)
			.where(eq(schema.summaries.meetingId, input.meetingId))
			.run();

		await tx
			.insert(schema.summaries)
			.values({
				meetingId: input.meetingId,
				highlights: input.summary.highlights,
				prose: input.summary.prose,
				model: input.summary.model,
				sourceKinds: input.sourceKinds,
				sourceFingerprint: input.sourceFingerprint,
				sourceDisagreements: input.sourceDisagreements,
			})
			.run();
		await insertFiscalDecisions(
			tx,
			input.meetingId,
			input.fiscalDecisions,
			ocrDocument !== undefined,
		);
		await insertBudgetDiscussions(tx, input.meetingId, input.budgetDiscussions);
	});
}

/**
 * Remove a meeting's transcript and the drama assessments scored from it.
 * Deletes run child-first. The transcript is read inside the transaction; a
 * meeting with no transcript deletes nothing.
 */
async function detachTranscriptTransaction(
	db: LibSQLDatabase<typeof schema>,
	meetingId: number,
): Promise<{ sourceUrl: string | null } | null> {
	return await db.transaction(async (tx) => {
		// The first transcript by id, the same one getMeetingSourcesQuery reports.
		const transcript = await tx
			.select({ sourceUrl: schema.transcripts.sourceUrl })
			.from(schema.transcripts)
			.where(eq(schema.transcripts.meetingId, meetingId))
			.orderBy(schema.transcripts.id)
			.limit(1)
			.get();
		if (transcript === undefined) return null;

		await tx
			.delete(schema.dramaCategoryScores)
			.where(
				inArray(
					schema.dramaCategoryScores.assessmentId,
					tx
						.select({ id: schema.dramaAssessments.id })
						.from(schema.dramaAssessments)
						.where(eq(schema.dramaAssessments.meetingId, meetingId)),
				),
			)
			.run();
		await tx
			.delete(schema.dramaAssessments)
			.where(eq(schema.dramaAssessments.meetingId, meetingId))
			.run();
		await tx
			.delete(schema.transcripts)
			.where(eq(schema.transcripts.meetingId, meetingId))
			.run();

		return { sourceUrl: transcript.sourceUrl };
	});
}

/**
 * When any source document was OCR, lower the default confidence so the
 * existing confidence-aware UI conveys the extra uncertainty without needing
 * an OCR-aware branch of its own.
 */
async function insertFiscalDecisions(
	tx: Tx,
	meetingId: number,
	rows: MeetingInput["fiscalDecisions"],
	hasOcrSource: boolean,
): Promise<void> {
	for (const fd of rows ?? []) {
		const confidence = hasOcrSource
			? fd.confidence * OCR_CONFIDENCE_MULTIPLIER
			: fd.confidence;
		await tx
			.insert(schema.fiscalDecisions)
			.values({
				meetingId,
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

async function insertBudgetDiscussions(
	tx: Tx,
	meetingId: number,
	rows: MeetingInput["budgetDiscussions"],
): Promise<void> {
	for (const bd of rows ?? []) {
		await tx
			.insert(schema.budgetDiscussions)
			.values({
				meetingId,
				topic: bd.topic,
				estimatedAmount: bd.estimatedAmount,
				notes: bd.notes,
			})
			.run();
	}
}

/**
 * Persist a drama assessment + 7 category-score rows atomically. Idempotent
 * on (meetingId, promptVersion, model). Storage-boundary invariant:
 * `level` must equal `mapSumToLevel(sum(scores))` — computed level wins on
 * mismatch.
 */
async function storeDramaAssessmentTransaction(
	db: LibSQLDatabase<typeof schema>,
	input: StoreDramaAssessmentInput,
): Promise<void> {
	const existing = await db
		.select({ id: schema.dramaAssessments.id })
		.from(schema.dramaAssessments)
		.where(
			and(
				eq(schema.dramaAssessments.meetingId, input.meetingId),
				eq(schema.dramaAssessments.promptVersion, input.promptVersion),
				eq(schema.dramaAssessments.model, input.model),
			),
		)
		.get();
	if (existing) return;

	let total = 0;
	for (const cat of DRAMA_CATEGORIES) {
		total += input.categoryScores[cat].score;
	}
	const computedLevel = mapSumToLevel(total);
	let level = input.level;
	if (computedLevel !== level) {
		console.warn(
			`[drama-storage] level override on insert: input "${level}", ` +
				`mapSumToLevel(${total}) = "${computedLevel}"`,
		);
		level = computedLevel;
	}

	const publishedAt = level === "off-the-rails" ? null : new Date();

	await db.transaction(async (tx) => {
		const assessment = await tx
			.insert(schema.dramaAssessments)
			.values({
				meetingId: input.meetingId,
				level,
				confidence: input.confidence,
				promptVersion: input.promptVersion,
				model: input.model,
				headline: input.headline,
				narrative: input.narrative,
				publishedAt,
			})
			.returning({ id: schema.dramaAssessments.id })
			.get();

		for (const cat of DRAMA_CATEGORIES) {
			const cs = input.categoryScores[cat];
			await tx
				.insert(schema.dramaCategoryScores)
				.values({
					assessmentId: assessment.id,
					category: cat,
					score: cs.score,
					evidenceQuotes: cs.evidenceQuotes,
				})
				.run();
		}
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

		const session = input.session ?? "";

		// Idempotency guard: (body_id, date, session) is the natural key. If
		// this meeting already exists, attach any documents from this call that
		// aren't already on it (idempotent by (meetingId, sourceUrl)) and return
		// the existing handle. The weekly ingestion cron re-sees the same eGov /
		// Finalsite listings every run; without the outer short-circuit every
		// listing would stack duplicate meeting / summary / fiscal rows. But a
		// sibling listing for the *same* meeting (agenda + minutes + ordinance)
		// should merge its document into the existing meeting rather than be
		// dropped. See issues #37 and #27.
		const sameDay = and(
			eq(schema.meetings.bodyId, body.id),
			eq(schema.meetings.date, input.date),
		);
		const byKey = await tx
			.select()
			.from(schema.meetings)
			.where(and(sameDay, eq(schema.meetings.session, session)))
			.get();

		// A session is derived from a label the source can reword. A same-day
		// meeting that already holds one of these documents is this meeting
		// under an earlier label, not a second one.
		const existing =
			byKey ??
			(input.documents.length === 0
				? undefined
				: (
						await tx
							.select({ meeting: schema.meetings })
							.from(schema.meetings)
							.innerJoin(
								schema.documents,
								eq(schema.documents.meetingId, schema.meetings.id),
							)
							.where(
								and(
									sameDay,
									inArray(
										schema.documents.sourceUrl,
										input.documents.map((d) => d.sourceUrl),
									),
								),
							)
							.orderBy(schema.meetings.id)
							.get()
					)?.meeting);

		if (existing) {
			for (const doc of input.documents) {
				const alreadyStored = await tx
					.select({ id: schema.documents.id })
					.from(schema.documents)
					.where(
						and(
							eq(schema.documents.meetingId, existing.id),
							eq(schema.documents.sourceUrl, doc.sourceUrl),
						),
					)
					.get();
				if (alreadyStored) continue;
				await tx
					.insert(schema.documents)
					.values({
						meetingId: existing.id,
						sourceUrl: doc.sourceUrl,
						rawText: doc.rawText,
						documentType: doc.documentType,
						extractionMethod: doc.extractionMethod,
					})
					.run();
			}
			return { id: existing.id, date: existing.date, bodyId: existing.bodyId };
		}

		// Insert meeting
		const meeting = await tx
			.insert(schema.meetings)
			.values({
				bodyId: body.id,
				date: input.date,
				session,
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
					sourceKinds: input.summary.sourceKinds ?? [],
					sourceFingerprint: input.summary.sourceFingerprint ?? "",
				})
				.run();
		}

		await insertFiscalDecisions(
			tx,
			meeting.id,
			input.fiscalDecisions,
			hasOcrSource,
		);
		await insertBudgetDiscussions(tx, meeting.id, input.budgetDiscussions);

		return { id: meeting.id, date: meeting.date, bodyId: meeting.bodyId };
	});
}

export { StorageService, StorageServiceLive, OCR_CONFIDENCE_MULTIPLIER };
export type {
	DramaCategoryScoreInput,
	ExtractionMethod,
	HeldVideo,
	HeldVideoInput,
	Meeting,
	MeetingInput,
	MeetingSources,
	MeetingSourceState,
	StoreDramaAssessmentInput,
	SummaryScope,
};
