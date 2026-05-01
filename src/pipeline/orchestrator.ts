import { Duration, Effect, Schedule } from "effect";
import { DRAMA_CATEGORIES } from "#/lib/drama-levels.ts";
import { normalizeEgovDate, normalizeFinalsiteDate } from "#/pipeline/dates.ts";
import {
	AlertService,
	formatPipelineErrorAlert,
	formatZeroResultsAlert,
} from "#/pipeline/services/AlertService.ts";
import { DramaDetectionService } from "#/pipeline/services/DramaDetectionService.ts";
import type { FinalsiteMeetingListing } from "#/pipeline/services/FinalsiteScraper.ts";
import { FinalsiteScraper } from "#/pipeline/services/FinalsiteScraper.ts";
import type { ExtractResult } from "#/pipeline/services/PdfExtractor.ts";
import type { EgovDocumentListing } from "#/pipeline/services/ScraperService.ts";
import { EgovScraper } from "#/pipeline/services/ScraperService.ts";
import type { MeetingInput } from "#/pipeline/services/StorageService.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import type { TranscriptResult } from "#/pipeline/services/TranscriptionService.ts";
import { TranscriptionService } from "#/pipeline/services/TranscriptionService.ts";
import { formatTranscriptWithTimestamps } from "#/pipeline/services/transcriptFormatting.ts";
import type { YouTubeVideo } from "#/pipeline/services/YouTubeScraper.ts";
import { YouTubeScraper } from "#/pipeline/services/YouTubeScraper.ts";

/** Threshold (in days) beyond which the zero-results anomaly alert fires. */
const ZERO_RESULTS_THRESHOLD_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function detectZeroResultsAnomaly(input: {
	body: BodyConfig;
	lastMeetingDate: string | null;
	now: Date;
}): Effect.Effect<void, never, AlertService> {
	if (!input.lastMeetingDate) return Effect.void;
	const lastMs = new Date(input.lastMeetingDate).getTime();
	const daysSince = Math.floor((input.now.getTime() - lastMs) / MS_PER_DAY);
	if (daysSince <= ZERO_RESULTS_THRESHOLD_DAYS) return Effect.void;

	const formatted = formatZeroResultsAlert({
		bodyName: input.body.name,
		daysSinceLastContent: daysSince,
	});
	return Effect.gen(function* () {
		const alert = yield* AlertService;
		yield* alert.sendAlert(formatted).pipe(Effect.catchAll(() => Effect.void));
	});
}

/**
 * Effect teaching note: The orchestrator is deliberately a plain function
 * that returns an Effect — not its own Context.Tag service. There's only one
 * implementation, and it composes other services via their Tags, so the
 * orchestrator's "requirements" are exactly the union of all its callees'
 * Tags. You can see this in the return type: the `R` (requirements)
 * parameter of `Effect.Effect<A, E, R>` is the union of every service it
 * pulls from context.
 *
 * Per-listing errors are handled inline with `Effect.catchAll` → alert →
 * continue, rather than bubbling up. That's a deliberate choice: a broken
 * listing for one body should not stop the whole pipeline. Fatal failures
 * (e.g. scraping the initial listing page) still fail the body loop so the
 * operator sees a stack-level error in the CLI output.
 */

/**
 * Effect teaching note: Schedule is Effect's policy type for deciding when to
 * retry. Schedule.exponential starts at the given base delay and doubles on
 * each retry; Schedule.compose with Schedule.recurs(n) bounds the total number
 * of attempts. Effect.retry(effect, schedule) wraps transient-failure-prone
 * operations (network fetches, LLM calls) so that flaky upstreams don't kill
 * the whole pipeline on the first hiccup.
 *
 * Retry policy values come from RunPipelineInput so tests can disable retries
 * (attempts: 0) and production can tune them without touching this file.
 *
 * Retries only help for *transient* failures. A 401 from Gemini won't get
 * better on retry — it'll just cost more money. The right answer is to tune
 * these policies based on observed failure modes rather than max them out.
 */
type RetryPolicy = {
	/** Number of additional attempts beyond the first. 0 disables retry. */
	attempts: number;
	/** Base delay for the exponential backoff, in milliseconds. */
	baseDelayMs: number;
};

const DEFAULT_NETWORK_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500 };
const DEFAULT_LLM_RETRY: RetryPolicy = { attempts: 2, baseDelayMs: 1000 };

function scheduleFromPolicy(policy: RetryPolicy) {
	return Schedule.exponential(Duration.millis(policy.baseDelayMs)).pipe(
		Schedule.compose(Schedule.recurs(policy.attempts)),
	);
}

type BodyConfig = {
	slug: string;
	name: string;
	/** eGov document-center search type id (e.g. "12" for minutes). */
	egovSearchType?: string;
	/**
	 * Required when `egovSearchType` is shared across multiple bodies — the
	 * portal's searchType=12 returns every "minutes" row regardless of body, so
	 * listings whose title doesn't match this pattern belong to a sibling and
	 * must be skipped before storage. See #35.
	 */
	egovTitlePattern?: RegExp;
	/** Full Finalsite page URL (e.g. https://www.rbbschools.net/school-board). */
	finalsiteUrl?: string;
	/** YouTube playlist ID for the body's meeting recordings. */
	youtubePlaylistId?: string;
};

type RunPipelineInput = {
	bodies: BodyConfig[];
	/** Milliseconds to sleep between eGov document downloads. Production: 300_000. */
	crawlDelayMs: number;
	/** Milliseconds to sleep between YouTube transcription calls. Production: 2000-5000. */
	youtubeDelayMs?: number;
	/**
	 * Converts a downloaded PDF (ArrayBuffer) into a tri-state extraction
	 * result. The `method` field tells the orchestrator whether the text came
	 * from the PDF's native text layer, an OCR fallback, or — when both paths
	 * yield nothing — that the PDF is `unreadable`. The orchestrator persists
	 * the `unreadable` case as a document row with empty text and skips
	 * summarization + fiscal extraction for that meeting instead of treating
	 * it as a pipeline failure.
	 */
	extractPdfText: (bytes: ArrayBuffer) => Promise<ExtractResult>;
	/** When true, run all stages except storage and alerts — for smoke-testing. */
	dryRun: boolean;
	/** Retry policy for network operations (scrape, download). Defaults to {3, 500ms}. */
	networkRetry?: RetryPolicy;
	/** Retry policy for LLM calls (summarize). Defaults to {2, 1000ms}. */
	llmRetry?: RetryPolicy;
	/** Current time used for zero-results anomaly detection. Defaults to new Date(). */
	now?: Date;
};

/**
 * Resolved form of the pipeline input — built once in runPipeline and passed
 * through to every child so each call site can read the pre-computed schedules
 * without recomputing them per listing.
 */
type ResolvedConfig = RunPipelineInput & {
	networkSchedule: ReturnType<typeof scheduleFromPolicy>;
	llmSchedule: ReturnType<typeof scheduleFromPolicy>;
	youtubeDelayMs: number;
	now: Date;
};

type PipelineResult = {
	processed: number;
	errors: number;
};

/**
 * Runs the full 5-stage pipeline (scrape → extract → transcribe → summarize
 * → store) for each configured body, in sequence.
 */
function runPipeline(
	input: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	never,
	| EgovScraper
	| FinalsiteScraper
	| YouTubeScraper
	| TranscriptionService
	| SummarizationService
	| StorageService
	| AlertService
	| DramaDetectionService
> {
	const config: ResolvedConfig = {
		...input,
		networkSchedule: scheduleFromPolicy(
			input.networkRetry ?? DEFAULT_NETWORK_RETRY,
		),
		llmSchedule: scheduleFromPolicy(input.llmRetry ?? DEFAULT_LLM_RETRY),
		youtubeDelayMs: input.youtubeDelayMs ?? 2000,
		now: input.now ?? new Date(),
	};

	return Effect.gen(function* () {
		let processed = 0;
		let errors = 0;

		for (const body of input.bodies) {
			const bodyResult = yield* runPipelineForBody(body, config);
			processed += bodyResult.processed;
			errors += bodyResult.errors;
		}

		return { processed, errors };
	});
}

function runPipelineForBody(
	body: BodyConfig,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	never,
	| EgovScraper
	| FinalsiteScraper
	| YouTubeScraper
	| TranscriptionService
	| SummarizationService
	| StorageService
	| AlertService
	| DramaDetectionService
> {
	return Effect.gen(function* () {
		// Zero-results anomaly check: alert if this body hasn't had fresh content
		// in more than 30 days, *before* we run the pipeline that might confirm
		// the gap. Silently skips on DatabaseError so the run continues regardless.
		const storage = yield* StorageService;
		const lastMeetingDate = yield* storage
			.getMostRecentMeetingDate(body.slug)
			.pipe(Effect.catchAll(() => Effect.succeed(null)));
		yield* detectZeroResultsAnomaly({
			body,
			lastMeetingDate,
			now: config.now,
		});

		let processed = 0;
		let errors = 0;

		if (body.egovSearchType) {
			const egovResult = yield* runEgovForBody(body, config);
			processed += egovResult.processed;
			errors += egovResult.errors;
		}

		if (body.finalsiteUrl) {
			const finalsiteResult = yield* runFinalsiteForBody(body, config);
			processed += finalsiteResult.processed;
			errors += finalsiteResult.errors;
		}

		if (body.youtubePlaylistId) {
			const youtubeResult = yield* runYouTubeForBody(body, config);
			processed += youtubeResult.processed;
			errors += youtubeResult.errors;
		}

		return { processed, errors };
	});
}

// ---------------------------------------------------------------------------
// Shared per-source helpers
// ---------------------------------------------------------------------------

/**
 * Effect teaching note: All three source paths share the same "fetch the
 * listings or fall through to an alert" pattern. Rather than inline the
 * Effect.map + Effect.catchAll in every runXForBody function, this helper
 * takes a pre-composed fetch effect (the caller is responsible for applying
 * retry, because the retry schedule is scoped to the caller's config) and
 * returns a discriminated union the caller can switch on.
 *
 * The generic `E extends TaggedPipelineError` constraint lets callers pass
 * scraper-specific error unions (e.g. NetworkError | ParseError) without
 * casting — the structural overlap with TaggedPipelineError is what matters
 * for the alertAndRecover call.
 */
function fetchListingsOrAlert<T, E extends TaggedPipelineError>(
	body: BodyConfig,
	fetchEffect: Effect.Effect<T[], E>,
): Effect.Effect<
	{ ok: true; listings: T[] } | { ok: false },
	never,
	AlertService
> {
	return fetchEffect.pipe(
		Effect.map((listings) => ({ ok: true as const, listings })),
		Effect.catchAll((error) =>
			alertAndRecover(body, "scrape", error).pipe(
				Effect.as({ ok: false as const }),
			),
		),
	);
}

/**
 * Effect teaching note: The second shared shape across every source path is
 * the per-item loop — iterate items, run processItem with its own catchAll
 * to alertAndRecover so one broken item doesn't stop the body, accumulate a
 * PipelineResult, and optionally sleep between items for rate-limit
 * compliance. Pulling this into one place means a change to the per-item
 * error path (or the delay strategy, or the filter semantics) edits one
 * function instead of three.
 *
 * The `R` type parameter carries the requirements of `processItem` straight
 * through to the caller, so each source keeps its own precise
 * `Effect.Effect<..., ..., EgovScraper | ...>` requirements in the return
 * type without any cast.
 */
function iterateWithAlertRecovery<TItem, R>(
	body: BodyConfig,
	items: readonly TItem[],
	options: {
		processItem: (
			item: TItem,
		) => Effect.Effect<PipelineResult, TaggedPipelineError, R>;
		delayBetweenItemsMs: number;
		shouldProcess?: (item: TItem) => boolean;
	},
): Effect.Effect<PipelineResult, never, R | AlertService> {
	return Effect.gen(function* () {
		let processed = 0;
		let errors = 0;

		for (const item of items) {
			if (options.shouldProcess && !options.shouldProcess(item)) continue;

			const result = yield* options
				.processItem(item)
				.pipe(
					Effect.catchAll((error) =>
						alertAndRecover(body, listingFailureStage(error), error).pipe(
							Effect.as({ processed: 0, errors: 1 }),
						),
					),
				);

			processed += result.processed;
			errors += result.errors;

			if (options.delayBetweenItemsMs > 0) {
				yield* Effect.sleep(Duration.millis(options.delayBetweenItemsMs));
			}
		}

		return { processed, errors };
	});
}

// ---------------------------------------------------------------------------
// eGov path
// ---------------------------------------------------------------------------

function runEgovForBody(
	body: BodyConfig & { egovSearchType?: string },
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	never,
	EgovScraper | SummarizationService | StorageService | AlertService
> {
	return Effect.gen(function* () {
		const searchType = body.egovSearchType;
		if (!searchType) return { processed: 0, errors: 0 };

		const scraper = yield* EgovScraper;

		const listingsResult = yield* fetchListingsOrAlert(
			body,
			scraper
				.scrapeListings({ searchType, page: 1 })
				.pipe(Effect.retry(config.networkSchedule)),
		);

		if (!listingsResult.ok) return { processed: 0, errors: 1 };

		const titlePattern = body.egovTitlePattern;

		return yield* iterateWithAlertRecovery(body, listingsResult.listings, {
			processItem: (listing) => processEgovListing(body, listing, config),
			delayBetweenItemsMs: config.crawlDelayMs,
			shouldProcess: titlePattern
				? (listing) => titlePattern.test(listing.title)
				: undefined,
		});
	});
}

function processEgovListing(
	body: BodyConfig,
	listing: EgovDocumentListing,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	TaggedPipelineError,
	EgovScraper | SummarizationService | StorageService
> {
	return Effect.gen(function* () {
		const scraper = yield* EgovScraper;
		const summarizer = yield* SummarizationService;
		const storage = yield* StorageService;

		const bytes = yield* scraper
			.downloadDocument(listing.downloadUrl)
			.pipe(Effect.retry(config.networkSchedule));

		const extraction = yield* Effect.tryPromise({
			try: () => config.extractPdfText(bytes),
			catch: (error) =>
				new PipelineExtractError({
					message: error instanceof Error ? error.message : String(error),
				}),
		});

		// Meeting date comes from the title when present — the eGov listing cell
		// is the publish/upload date, which collapses to the day staff posted a
		// batch and would cause distinct meetings to merge. Fall back to the
		// publish date only when the title has no extractable long-form date
		// (rare; annual reports and similar). See #27.
		const meetingDate = listing.meetingDate ?? normalizeEgovDate(listing.date);

		// Unreadable branch: persist the document row so the meeting appears in
		// listings with a link to the PDF, but skip summarization + fiscal
		// extraction entirely. This is the "silent hole" the PRD is eliminating
		// — previously, a scanned PDF would fail extraction and the whole row
		// would be dropped, making the meeting invisible on the public site.
		if (extraction.method === "unreadable") {
			if (config.dryRun) return { processed: 1, errors: 0 };

			yield* storage.storeMeeting({
				bodySlug: body.slug,
				date: meetingDate,
				meetingType: "regular",
				documents: [
					{
						sourceUrl: listing.downloadUrl,
						rawText: "",
						documentType: listing.documentType,
						extractionMethod: "unreadable",
					},
				],
			});

			return { processed: 1, errors: 0 };
		}

		const summary = yield* summarizer
			.summarize({
				sourceText: extraction.text,
				meetingContext: `${body.name}, ${listing.date}`,
			})
			.pipe(Effect.retry(config.llmSchedule));

		if (config.dryRun) return { processed: 1, errors: 0 };

		const meetingInput: MeetingInput = {
			bodySlug: body.slug,
			date: meetingDate,
			meetingType: "regular",
			documents: [
				{
					sourceUrl: listing.downloadUrl,
					rawText: extraction.text,
					documentType: listing.documentType,
					extractionMethod: extraction.method,
				},
			],
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		};

		yield* storage.storeMeeting(meetingInput);

		return { processed: 1, errors: 0 };
	});
}

// ---------------------------------------------------------------------------
// Finalsite path
// ---------------------------------------------------------------------------

function runFinalsiteForBody(
	body: BodyConfig,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	never,
	FinalsiteScraper | SummarizationService | StorageService | AlertService
> {
	return Effect.gen(function* () {
		const scraper = yield* FinalsiteScraper;

		const listingsResult = yield* fetchListingsOrAlert(
			body,
			scraper.scrapeListings().pipe(Effect.retry(config.networkSchedule)),
		);

		if (!listingsResult.ok) return { processed: 0, errors: 1 };

		return yield* iterateWithAlertRecovery(body, listingsResult.listings, {
			processItem: (listing) => processFinalsiteListing(body, listing, config),
			delayBetweenItemsMs: 0,
			shouldProcess: (listing) => listing.documents.length > 0,
		});
	});
}

function processFinalsiteListing(
	body: BodyConfig,
	listing: FinalsiteMeetingListing,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	TaggedPipelineError,
	FinalsiteScraper | SummarizationService | StorageService
> {
	return Effect.gen(function* () {
		const scraper = yield* FinalsiteScraper;
		const summarizer = yield* SummarizationService;
		const storage = yield* StorageService;

		const documents: MeetingInput["documents"] = [];
		let combinedText = "";

		for (const doc of listing.documents) {
			const bytes = yield* scraper
				.downloadDocument(doc.uuid)
				.pipe(Effect.retry(config.networkSchedule));

			const extraction = yield* Effect.tryPromise({
				try: () => config.extractPdfText(bytes),
				catch: (error) =>
					new PipelineExtractError({
						message: error instanceof Error ? error.message : String(error),
					}),
			});
			documents.push({
				sourceUrl: doc.downloadUrl,
				rawText: extraction.text,
				documentType:
					doc.documentType === "notice" ? "agenda" : doc.documentType,
				extractionMethod: extraction.method,
			});
			if (extraction.method !== "unreadable") {
				combinedText += `\n${extraction.text}`;
			}
		}

		// If every document for the meeting came back unreadable, skip
		// summarization and persist the meeting + document rows so the meeting
		// still appears in listings with a PDF link. Otherwise summarize the
		// concatenated text of the readable documents and persist normally.
		const allUnreadable = documents.every(
			(d) => d.extractionMethod === "unreadable",
		);

		if (allUnreadable) {
			if (config.dryRun) return { processed: 1, errors: 0 };

			yield* storage.storeMeeting({
				bodySlug: body.slug,
				date: normalizeFinalsiteDate(listing.date, listing.year),
				meetingType: meetingTypeFromFinalsiteLabel(listing.meetingType),
				documents,
			});

			return { processed: 1, errors: 0 };
		}

		const summary = yield* summarizer
			.summarize({
				sourceText: combinedText,
				meetingContext: `${body.name}, ${listing.date}`,
			})
			.pipe(Effect.retry(config.llmSchedule));

		if (config.dryRun) return { processed: 1, errors: 0 };

		yield* storage.storeMeeting({
			bodySlug: body.slug,
			date: normalizeFinalsiteDate(listing.date, listing.year),
			meetingType: meetingTypeFromFinalsiteLabel(listing.meetingType),
			documents,
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		});

		return { processed: 1, errors: 0 };
	});
}

// ---------------------------------------------------------------------------
// YouTube path
// ---------------------------------------------------------------------------

function runYouTubeForBody(
	body: BodyConfig,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	never,
	| YouTubeScraper
	| TranscriptionService
	| SummarizationService
	| StorageService
	| AlertService
	| DramaDetectionService
> {
	return Effect.gen(function* () {
		const playlistId = body.youtubePlaylistId;
		if (!playlistId) return { processed: 0, errors: 0 };

		const scraper = yield* YouTubeScraper;

		const videosResult = yield* fetchListingsOrAlert(
			body,
			scraper
				.listPlaylistVideos(playlistId)
				.pipe(Effect.retry(config.networkSchedule)),
		);

		if (!videosResult.ok) return { processed: 0, errors: 1 };

		return yield* iterateWithAlertRecovery(body, videosResult.listings, {
			processItem: (video) => processYouTubeVideo(body, video, config),
			delayBetweenItemsMs: config.youtubeDelayMs,
		});
	});
}

function processYouTubeVideo(
	body: BodyConfig,
	video: YouTubeVideo,
	config: ResolvedConfig,
): Effect.Effect<
	PipelineResult,
	TaggedPipelineError,
	| TranscriptionService
	| SummarizationService
	| StorageService
	| DramaDetectionService
	| AlertService
> {
	return Effect.gen(function* () {
		const transcription = yield* TranscriptionService;
		const summarizer = yield* SummarizationService;
		const storage = yield* StorageService;

		const transcript = yield* transcription
			.transcribe(video.videoId)
			.pipe(Effect.retry(config.networkSchedule));

		const summary = yield* summarizer
			.summarize({
				sourceText: transcript.rawText,
				meetingContext: `${body.name}, ${video.title}`,
			})
			.pipe(Effect.retry(config.llmSchedule));

		if (config.dryRun) return { processed: 1, errors: 0 };

		const meeting = yield* storage.storeMeeting({
			bodySlug: body.slug,
			date: video.publishedAt.slice(0, 10),
			meetingType: "regular",
			documents: [],
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		});

		yield* storage.storeTranscript({
			meetingId: meeting.id,
			source: transcript.source,
			rawText: transcript.rawText,
			segments: transcript.segments,
			sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
		});

		// Drama detection runs AFTER transcript storage. Failure must not
		// regress transcript or summary persistence — those are first-class
		// transparency artifacts. The catchAll below absorbs any error,
		// alerts the operator, and returns Effect.void so the orchestrator's
		// tagged-error channel is unaffected.
		yield* runDramaDetection({
			body,
			video,
			meetingId: meeting.id,
			transcript,
		}).pipe(Effect.catchAll((error) => alertDramaFailure(body, error)));

		return { processed: 1, errors: 0 };
	});
}

function runDramaDetection(input: {
	body: BodyConfig;
	video: YouTubeVideo;
	meetingId: number;
	transcript: TranscriptResult;
}) {
	return Effect.gen(function* () {
		const detector = yield* DramaDetectionService;
		const storage = yield* StorageService;

		const formatted = formatTranscriptWithTimestamps(input.transcript);

		const assessment = yield* detector.detect({
			sourceText: formatted,
			meetingContext: `${input.body.name}, ${input.video.title}`,
		});

		const categoryScores = Object.fromEntries(
			DRAMA_CATEGORIES.map((cat) => [
				cat,
				{
					score: assessment.category_scores[cat].score,
					evidenceQuotes: assessment.category_scores[cat].evidence_quotes,
				},
			]),
		) as Parameters<typeof storage.storeDramaAssessment>[0]["categoryScores"];

		yield* storage.storeDramaAssessment({
			meetingId: input.meetingId,
			level: assessment.level,
			confidence: assessment.confidence,
			promptVersion: assessment.promptVersion,
			model: assessment.model,
			headline: assessment.headline,
			narrative: assessment.narrative,
			categoryScores,
		});
	});
}

function alertDramaFailure(body: BodyConfig, error: unknown) {
	return Effect.gen(function* () {
		const alert = yield* AlertService;
		const tag =
			typeof error === "object" && error !== null && "_tag" in error
				? String((error as { _tag: unknown })._tag)
				: "DramaDetectionError";
		const message =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null && "message" in error
					? String((error as { message: unknown }).message)
					: String(error);
		yield* alert
			.sendAlert(
				formatPipelineErrorAlert({
					stage: "drama-detection",
					bodyName: body.name,
					errorTag: tag,
					errorMessage: message,
				}),
			)
			.pipe(Effect.catchAll(() => Effect.void));
	});
}

// ---------------------------------------------------------------------------
// Error + alert plumbing
// ---------------------------------------------------------------------------

/**
 * Marker for the "PDF extraction" stage — this is the one stage whose
 * failure can't come from the services themselves (they return NetworkError,
 * LlmError, etc). Having a dedicated tag lets `alertAndRecover` pattern-match
 * on it the same way it handles the service errors.
 */
class PipelineExtractError {
	readonly _tag = "PipelineExtractError";
	readonly message: string;
	constructor(input: { message: string }) {
		this.message = input.message;
	}
}

type TaggedPipelineError =
	| { readonly _tag: "NetworkError"; readonly message: string }
	| { readonly _tag: "ParseError"; readonly message: string }
	| { readonly _tag: "TranscriptionError"; readonly message: string }
	| { readonly _tag: "LlmError"; readonly message: string }
	| { readonly _tag: "DatabaseError"; readonly message: string }
	| PipelineExtractError;

function listingFailureStage(error: TaggedPipelineError): string {
	switch (error._tag) {
		case "NetworkError":
			return "download";
		case "ParseError":
			return "extract";
		case "PipelineExtractError":
			return "extract";
		case "TranscriptionError":
			return "transcribe";
		case "LlmError":
			return "summarize";
		case "DatabaseError":
			return "store";
		default:
			return "unknown";
	}
}

function alertAndRecover(
	body: BodyConfig,
	stage: string,
	error: TaggedPipelineError,
): Effect.Effect<void, never, AlertService> {
	return Effect.gen(function* () {
		const alert = yield* AlertService;
		const formatted = formatPipelineErrorAlert({
			stage,
			bodyName: body.name,
			errorTag: error._tag,
			errorMessage: error.message,
		});
		yield* alert.sendAlert(formatted).pipe(Effect.catchAll(() => Effect.void));
	});
}

// ---------------------------------------------------------------------------
// Per-source helpers
// ---------------------------------------------------------------------------

function meetingTypeFromFinalsiteLabel(
	label: string,
): MeetingInput["meetingType"] {
	const lower = label.toLowerCase();
	if (lower.includes("special")) return "special";
	if (lower.includes("workshop")) return "workshop";
	return "regular";
}

/**
 * One-shot entry point: run the YouTube branch on a single video. Used by
 * the `drama:detect` CLI subcommand for first-run inspection of a known
 * meeting before configuring the full playlist on a body. Bypasses
 * YouTubeScraper.listPlaylistVideos entirely — the operator supplies the
 * video metadata directly.
 */
function runDramaDetectForVideo(input: {
	body: BodyConfig;
	video: YouTubeVideo;
	networkRetry?: RetryPolicy;
	llmRetry?: RetryPolicy;
	now?: Date;
}): Effect.Effect<
	PipelineResult,
	never,
	| TranscriptionService
	| SummarizationService
	| StorageService
	| AlertService
	| DramaDetectionService
> {
	const config: ResolvedConfig = {
		bodies: [input.body],
		crawlDelayMs: 0,
		youtubeDelayMs: 0,
		extractPdfText: async () => ({ text: "", method: "unreadable" }),
		dryRun: false,
		networkSchedule: scheduleFromPolicy(
			input.networkRetry ?? DEFAULT_NETWORK_RETRY,
		),
		llmSchedule: scheduleFromPolicy(input.llmRetry ?? DEFAULT_LLM_RETRY),
		now: input.now ?? new Date(),
	};

	return processYouTubeVideo(input.body, input.video, config).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				const alert = yield* AlertService;
				yield* alert
					.sendAlert(
						formatPipelineErrorAlert({
							stage: error._tag,
							bodyName: input.body.name,
							errorTag: error._tag,
							errorMessage: error.message,
						}),
					)
					.pipe(Effect.catchAll(() => Effect.void));
				return { processed: 0, errors: 1 };
			}),
		),
	);
}

export { runDramaDetectForVideo, runPipeline };
export type { BodyConfig, RunPipelineInput, PipelineResult, RetryPolicy };
