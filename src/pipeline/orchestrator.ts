import { Duration, Effect, Schedule } from "effect";
import { DRAMA_CATEGORIES, type DramaCategory } from "#/lib/drama-levels.ts";
import { extractLongFormDate, readFinalsiteDate } from "#/pipeline/dates.ts";
import {
	type DatabaseError,
	type LlmError,
	type NetworkError,
	type ParseError,
	TranscriptionError,
} from "#/pipeline/errors.ts";
import { regenerateMeetingSummary } from "#/pipeline/regenerate.ts";
import {
	type AlertScope,
	AlertService,
	formatHeldVideoAlert,
	formatPipelineErrorAlert,
	formatZeroResultsAlert,
} from "#/pipeline/services/AlertService.ts";
import { DramaDetectionService } from "#/pipeline/services/DramaDetectionService.ts";
import type { FinalsiteMeetingListing } from "#/pipeline/services/FinalsiteScraper.ts";
import { FinalsiteScraper } from "#/pipeline/services/FinalsiteScraper.ts";
import type { ExtractResult } from "#/pipeline/services/PdfExtractor.ts";
import type { EgovDocumentListing } from "#/pipeline/services/ScraperService.ts";
import { EgovScraper } from "#/pipeline/services/ScraperService.ts";
import type {
	DramaCategoryScoreInput,
	HeldVideoInput,
	MeetingInput,
} from "#/pipeline/services/StorageService.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import type { LabelledSource } from "#/pipeline/services/SummarizationService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import type { TranscriptResult } from "#/pipeline/services/TranscriptionService.ts";
import { TranscriptionService } from "#/pipeline/services/TranscriptionService.ts";
import { formatTranscriptWithTimestamps } from "#/pipeline/services/transcriptFormatting.ts";
import type { YouTubeVideo } from "#/pipeline/services/YouTubeScraper.ts";
import { YouTubeScraper } from "#/pipeline/services/YouTubeScraper.ts";
import { fingerprintOfSources, sessionSlug } from "#/pipeline/sources.ts";
import { readVideoTitle } from "#/pipeline/video-title.ts";

/** Threshold (in days) beyond which the zero-results anomaly alert fires. */
const ZERO_RESULTS_THRESHOLD_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Days a video must have been published before missing caption tracks count
 * as disabled captions. YouTube generates automatic captions some time after
 * upload, so a fresh video without tracks looks the same as one that will
 * never have them, and a hold is permanent.
 */
const CAPTIONS_GRACE_DAYS = 7;

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
		yield* alert.sendAlert(formatted).pipe(Effect.catch(() => Effect.void));
	});
}

/**
 * Effect teaching note: The orchestrator is deliberately a plain function
 * that returns an Effect — not its own Context.Service. There's only one
 * implementation, and it composes other services via their Tags, so the
 * orchestrator's "requirements" are exactly the union of all its callees'
 * Tags. You can see this in the return type: the `R` (requirements)
 * parameter of `Effect.Effect<A, E, R>` is the union of every service it
 * pulls from context.
 *
 * Per-listing errors are handled inline with `Effect.catch` → alert →
 * continue, rather than bubbling up. That's a deliberate choice: a broken
 * listing for one body should not stop the whole pipeline. Fatal failures
 * (e.g. scraping the initial listing page) still fail the body loop so the
 * operator sees a stack-level error in the CLI output.
 */

/**
 * Effect teaching note: Schedule is Effect's policy type for deciding when to
 * retry. Schedule.exponential starts at the given base delay and doubles on
 * each retry; Schedule.max([exponential, Schedule.recurs(n)]) recurs only while
 * every schedule still recurs (so recurs(n) bounds the total number of
 * retries) and waits the longest delay, which is the exponential one because
 * recurs has no delay. Effect.retry(effect, schedule) wraps transient-failure-prone
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

function scheduleFromPolicy(
	policy: RetryPolicy,
): Schedule.Schedule<Duration.Duration> {
	return Schedule.max([
		Schedule.exponential(Duration.millis(policy.baseDelayMs)),
		Schedule.recurs(policy.attempts),
	]);
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
	/**
	 * What a playlist title must start with to be this body's recording, e.g.
	 * "Ellettsville Town Council". Defaults to `name`.
	 */
	youtubeTitlePrefix?: string;
	/** ISO date; playlist videos dated earlier are ignored. */
	youtubeSince?: string;
};

/** The source paths a run can be limited to. */
const PIPELINE_SOURCES = ["egov", "finalsite", "youtube"] as const;
type PipelineSource = (typeof PIPELINE_SOURCES)[number];

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
	/** Source paths to run. Defaults to all of them. */
	sources?: readonly PipelineSource[];
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
	enabledSources: ReadonlySet<PipelineSource>;
};

type PipelineResult = {
	processed: number;
	errors: number;
};

/**
 * One item's result. `requested: false` marks an item settled without a
 * request to its source, which the per-item delay has no reason to pace.
 */
type ItemResult = PipelineResult & { requested?: false };

const SETTLED_WITHOUT_REQUEST: ItemResult = {
	processed: 0,
	errors: 0,
	requested: false,
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
		enabledSources: new Set(input.sources ?? PIPELINE_SOURCES),
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
			.pipe(Effect.catch(() => Effect.succeed(null)));
		yield* detectZeroResultsAnomaly({
			body,
			lastMeetingDate,
			now: config.now,
		});

		let processed = 0;
		let errors = 0;

		if (body.egovSearchType && config.enabledSources.has("egov")) {
			const egovResult = yield* runEgovForBody(body, config);
			processed += egovResult.processed;
			errors += egovResult.errors;
		}

		if (body.finalsiteUrl && config.enabledSources.has("finalsite")) {
			const finalsiteResult = yield* runFinalsiteForBody(body, config);
			processed += finalsiteResult.processed;
			errors += finalsiteResult.errors;
		}

		if (body.youtubePlaylistId && config.enabledSources.has("youtube")) {
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
 * Effect.map + Effect.catch in every runXForBody function, this helper
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
		Effect.catch((error) =>
			alertAndRecover(body, "scrape", error, "body").pipe(
				Effect.as({ ok: false as const }),
			),
		),
	);
}

/**
 * Effect teaching note: The second shared shape across every source path is
 * the per-item loop — iterate items, run processItem with its own catch
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
		) => Effect.Effect<ItemResult, TaggedPipelineError, R>;
		delayBetweenItemsMs: number;
		shouldProcess?: (item: TItem) => boolean;
	},
): Effect.Effect<PipelineResult, never, R | AlertService> {
	return Effect.gen(function* () {
		let processed = 0;
		let errors = 0;

		for (const item of items) {
			if (options.shouldProcess && !options.shouldProcess(item)) continue;

			const outcome = yield* options.processItem(item).pipe(
				Effect.map((result) => ({
					result,
					requested: result.requested !== false,
				})),
				Effect.catch((error) =>
					alertAndRecover(body, listingFailureStage(error), error, "item").pipe(
						Effect.as({
							result: { processed: 0, errors: 1 },
							requested: error._tag !== "UndatedListingError",
						}),
					),
				),
			);

			processed += outcome.result.processed;
			errors += outcome.result.errors;

			// The delay paces requests to the source. A listing held for its
			// date, or settled from what storage already holds, made no request
			// and has nothing to pace.
			if (options.delayBetweenItemsMs > 0 && outcome.requested) {
				yield* Effect.sleep(Duration.millis(options.delayBetweenItemsMs));
			}
		}

		return { processed, errors };
	});
}

/**
 * Settles a listing's documents against a meeting that already has documents:
 * attaches the ones the meeting lacks, then rebuilds the summary from every
 * source the meeting now holds. No same-meeting check is needed, since the
 * source dated both sets of documents itself.
 *
 * A listing is re-read on every run, so most calls bring nothing new. Those
 * cost no summarize call: `regenerateMeetingSummary` compares fingerprints
 * and leaves a summary stored without one alone.
 */
function attachDocumentsAndRegenerate(input: {
	meetingId: number;
	meeting: Omit<
		MeetingInput,
		"summary" | "fiscalDecisions" | "budgetDiscussions"
	>;
	meetingContext: string;
	config: ResolvedConfig;
}): Effect.Effect<
	void,
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;

		const held = yield* storage.getMeetingSources(input.meetingId);
		const heldUrls = new Set(held.documents.map((d) => d.sourceUrl));
		const bringsNewDocument = input.meeting.documents.some(
			(d) => !heldUrls.has(d.sourceUrl),
		);

		if (bringsNewDocument) {
			// `regenerateMeetingSummary` leaves a summary stored without a
			// fingerprint alone, and it would look current after the attach, so a
			// failed regeneration would never be retried. Stamping it with the
			// fingerprint of the sources it was built from first makes the attach
			// leave it visibly behind and due.
			if (held.summary?.sourceFingerprint === "") {
				yield* storage.stampSummaryFingerprint({
					meetingId: input.meetingId,
					sourceFingerprint: fingerprintOfSources({
						documents: held.documents,
						transcriptUrl: held.transcript?.sourceUrl,
					}),
				});
			}
			yield* storage.storeMeeting(input.meeting);
		}

		yield* Effect.log("regenerate.start").pipe(
			Effect.annotateLogs({ meetingId: input.meetingId, bringsNewDocument }),
		);
		const { regenerated } = yield* regenerateMeetingSummary({
			meetingId: input.meetingId,
			meetingContext: input.meetingContext,
		}).pipe(
			Effect.retry({
				schedule: input.config.llmSchedule,
				while: (error) => error._tag === "LlmError",
			}),
		);
		yield* Effect.log("regenerate.finish").pipe(
			Effect.annotateLogs({ meetingId: input.meetingId, regenerated }),
		);
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

		// The listing cell is the upload date, which collapses to the day staff
		// posted a batch. Filing a meeting under it merges distinct meetings
		// onto a date none of them took place, so a title with no readable
		// date is held for the operator rather than guessed at.
		const meetingDate = listing.meetingDate;
		if (meetingDate === null) {
			return yield* Effect.fail(
				new UndatedListingError({
					title: listing.title,
					uploadDate: listing.date,
				}),
			);
		}

		yield* Effect.log("egov.download.start");
		const bytes = yield* scraper
			.downloadDocument(listing.downloadUrl)
			.pipe(Effect.retry(config.networkSchedule));
		yield* Effect.log("egov.download.finish").pipe(
			Effect.annotateLogs({ bytes: bytes.byteLength }),
		);

		yield* Effect.log("egov.extract.start");
		const extraction = yield* Effect.tryPromise({
			try: () => config.extractPdfText(bytes),
			catch: (error) =>
				new PipelineExtractError({
					message: error instanceof Error ? error.message : String(error),
				}),
		});
		yield* Effect.log("egov.extract.finish").pipe(
			Effect.annotateLogs({ method: extraction.method }),
		);

		// A meeting that already has documents takes this one as a further
		// source of the same summary. One that has only a transcript falls
		// through to the single-document path below.
		const existing = config.dryRun
			? null
			: yield* storage.getMeetingSourceState({
					bodySlug: body.slug,
					date: meetingDate,
					session: "",
				});
		if (existing?.hasDocuments) {
			yield* attachDocumentsAndRegenerate({
				meetingId: existing.meetingId,
				meeting: {
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
				},
				meetingContext: `${body.name}, ${meetingDate}`,
				config,
			});
			return { processed: 1, errors: 0 };
		}

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

		yield* Effect.log("egov.summarize.start");
		const summary = yield* summarizer
			.summarize({
				sources: [{ kind: "documents", text: extraction.text }],
				meetingContext: `${body.name}, ${meetingDate}`,
			})
			.pipe(Effect.retry(config.llmSchedule));
		yield* Effect.log("egov.summarize.finish");

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
				sourceKinds: ["documents"],
				sourceFingerprint: fingerprintOfSources({
					documents: [{ sourceUrl: listing.downloadUrl }],
				}),
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		};

		yield* storage.storeMeeting(meetingInput);

		return { processed: 1, errors: 0 };
	}).pipe(
		Effect.annotateLogs({
			body: body.slug,
			source: "egov",
			url: listing.downloadUrl,
		}),
	);
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

		const reading = readFinalsiteDate(listing.date, listing.year);

		// A month-and-year cell with no day is not a dated meeting; skip it
		// without storing, downloading, or alerting.
		if (reading.kind === "month-only") {
			yield* Effect.log("finalsite.listing.skipped").pipe(
				Effect.annotateLogs({
					reason: "month-only date",
					date: listing.date,
					meetingType: listing.meetingType,
				}),
			);
			return { processed: 0, errors: 0 };
		}

		// A date cell the parser cannot read is held for the operator rather
		// than filed under a guessed date, which would merge distinct meetings.
		if (reading.kind === "unreadable") {
			return yield* Effect.fail(
				new UndatedListingError({
					title: `${listing.meetingType} (${listing.date})`,
					uploadDate: null,
				}),
			);
		}
		const meetingDate = reading.date;

		// The session slug is part of the meeting's key, and an empty one is the
		// value that merges every meeting on a date. A type cell that slugs to
		// nothing is held for the operator for the same reason.
		const session = sessionSlug(listing.meetingType);
		if (session === "") {
			return yield* Effect.fail(
				new UnsessionedListingError({
					title: `${listing.meetingType} (${listing.date})`,
				}),
			);
		}

		const documents: MeetingInput["documents"] = [];
		const readableSources: LabelledSource[] = [];

		for (const doc of listing.documents) {
			yield* Effect.gen(function* () {
				yield* Effect.log("finalsite.download.start");
				const bytes = yield* scraper
					.downloadDocument(doc.uuid)
					.pipe(Effect.retry(config.networkSchedule));
				yield* Effect.log("finalsite.download.finish").pipe(
					Effect.annotateLogs({ bytes: bytes.byteLength }),
				);

				yield* Effect.log("finalsite.extract.start");
				const extraction = yield* Effect.tryPromise({
					try: () => config.extractPdfText(bytes),
					catch: (error) =>
						new PipelineExtractError({
							message: error instanceof Error ? error.message : String(error),
						}),
				});
				yield* Effect.log("finalsite.extract.finish").pipe(
					Effect.annotateLogs({ method: extraction.method }),
				);

				documents.push({
					sourceUrl: doc.downloadUrl,
					rawText: extraction.text,
					documentType:
						doc.documentType === "notice" ? "agenda" : doc.documentType,
					extractionMethod: extraction.method,
				});
				if (extraction.method !== "unreadable") {
					readableSources.push({ kind: "documents", text: extraction.text });
				}
			}).pipe(Effect.annotateLogs({ uuid: doc.uuid, url: doc.downloadUrl }));
		}

		const meetingType = meetingTypeFromFinalsiteLabel(listing.meetingType);

		// A meeting that already has documents takes these as further sources
		// of the same summary. One that has only a transcript falls through to
		// the paths below.
		const existing = config.dryRun
			? null
			: yield* storage.getMeetingSourceState({
					bodySlug: body.slug,
					date: meetingDate,
					session,
				});
		if (existing?.hasDocuments) {
			yield* attachDocumentsAndRegenerate({
				meetingId: existing.meetingId,
				meeting: {
					bodySlug: body.slug,
					date: meetingDate,
					session,
					meetingType,
					documents,
				},
				meetingContext: `${body.name}, ${listing.date}`,
				config,
			});
			return { processed: 1, errors: 0 };
		}

		// If every document for the meeting came back unreadable, skip
		// summarization and persist the meeting + document rows so the meeting
		// still appears in listings with a PDF link. Otherwise summarize the
		// readable documents together and persist normally.
		const allUnreadable = documents.every(
			(d) => d.extractionMethod === "unreadable",
		);

		if (allUnreadable) {
			if (config.dryRun) return { processed: 1, errors: 0 };

			yield* storage.storeMeeting({
				bodySlug: body.slug,
				date: meetingDate,
				session,
				meetingType,
				documents,
			});

			return { processed: 1, errors: 0 };
		}

		yield* Effect.log("finalsite.summarize.start");
		const summary = yield* summarizer
			.summarize({
				sources: readableSources,
				meetingContext: `${body.name}, ${listing.date}`,
			})
			.pipe(Effect.retry(config.llmSchedule));
		yield* Effect.log("finalsite.summarize.finish");

		if (config.dryRun) return { processed: 1, errors: 0 };

		yield* storage.storeMeeting({
			bodySlug: body.slug,
			date: meetingDate,
			session,
			meetingType,
			documents,
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
				sourceKinds: ["documents"],
				sourceFingerprint: fingerprintOfSources({ documents }),
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		});

		return { processed: 1, errors: 0 };
	}).pipe(Effect.annotateLogs({ body: body.slug, source: "finalsite" }));
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
			processItem: (video) => processPlaylistVideo(body, video, config),
			delayBetweenItemsMs: config.youtubeDelayMs,
		});
	});
}

function videoUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Decides what one playlist entry is before anything is fetched for it. The
 * playlist is listed in full on every run, so every outcome short of
 * transcription has to be reached from the title and storage alone.
 */
function processPlaylistVideo(
	body: BodyConfig,
	video: YouTubeVideo,
	config: ResolvedConfig,
): Effect.Effect<
	ItemResult,
	TaggedPipelineError,
	| TranscriptionService
	| SummarizationService
	| StorageService
	| DramaDetectionService
	| AlertService
> {
	return Effect.gen(function* () {
		const hold = (videoHold: VideoHold) =>
			holdVideoAndAlert(body, video, videoHold, config);

		// The publish date is the day the recording reached the playlist, which
		// trails the meeting and is shared by videos posted together, and a
		// playlist can carry another body's recording. A title that is not this
		// body's dated meeting is held for the operator rather than filed.
		const titlePrefix = body.youtubeTitlePrefix ?? body.name;
		const reading = readVideoTitle(video.title, titlePrefix);
		if (reading.kind === "unrecognized") {
			// The date is recorded for the operator reading the held list; it
			// keys nothing, so any long-form date in the title will do.
			yield* hold({
				reason: "unrecognized-title",
				meetingDate: extractLongFormDate(video.title),
			});
			return SETTLED_WITHOUT_REQUEST;
		}

		if (body.youtubeSince && reading.date < body.youtubeSince) {
			return SETTLED_WITHOUT_REQUEST;
		}

		const storage = yield* StorageService;
		if (
			(yield* storage.hasTranscriptForVideo(videoUrl(video.videoId))) ||
			(yield* storage.isVideoHeld(video.videoId))
		) {
			return SETTLED_WITHOUT_REQUEST;
		}

		// A meeting that already has documents or another video's transcript
		// has a summary this video was not part of. Storing would attach the
		// transcript without changing that summary, so the video is left for
		// the run that can combine them.
		const existing = yield* storage.getMeetingSourceState({
			bodySlug: body.slug,
			date: reading.date,
			session: reading.session,
		});
		if (
			existing &&
			(existing.hasDocuments || existing.transcriptSourceUrl !== null)
		) {
			yield* Effect.log("youtube.video.deferred").pipe(
				Effect.annotateLogs({
					meetingId: existing.meetingId,
					date: reading.date,
					session: reading.session,
					reason: existing.hasDocuments
						? "meeting-has-documents"
						: "meeting-has-transcript",
				}),
			);
			return SETTLED_WITHOUT_REQUEST;
		}

		return yield* processYouTubeVideo(
			body,
			video,
			{
				date: reading.date,
				session: reading.session,
				meetingType: meetingTypeFromFinalsiteLabel(reading.qualifier ?? ""),
			},
			config,
		).pipe(
			// Only confirmed-disabled captions on a video past the grace period
			// are a hold. Every other transcription failure stays an error, so
			// the next run retries it. An unreadable publish date never holds.
			Effect.catchTag("TranscriptionError", (error) =>
				Effect.gen(function* () {
					if (error.captionsDisabled !== true) return yield* Effect.fail(error);
					const graceElapsed =
						config.now.getTime() - Date.parse(video.publishedAt) >=
						CAPTIONS_GRACE_DAYS * MS_PER_DAY;
					if (!graceElapsed) {
						// A disabled-captions reading that was not held is not yet
						// trusted, so the operator's alert must not state it as fact.
						return yield* new TranscriptionError({
							videoId: video.videoId,
							message: `No captions found yet for "${video.title}"; the video is retried on a later run`,
						});
					}
					yield* hold({ reason: "no-captions", meetingDate: reading.date });
					return { processed: 0, errors: 0 };
				}),
			),
		);
	}).pipe(Effect.annotateLogs({ body: body.slug, videoId: video.videoId }));
}

/** Why a video is held, and what the same-meeting check found when it ran. */
type VideoHold = Pick<
	HeldVideoInput,
	| "reason"
	| "meetingDate"
	| "probability"
	| "sharedIdentifiers"
	| "candidateMeetingId"
>;

/**
 * Records `video` as held and alerts the operator the first time only. The
 * playlist is re-read on every run, so the alert follows the write, not the
 * decision to hold. A dry run writes and alerts nothing, so it only reports
 * what it would hold.
 */
function holdVideoAndAlert(
	body: BodyConfig,
	video: VideoRef,
	hold: VideoHold,
	options: { readonly dryRun: boolean },
): Effect.Effect<void, DatabaseError, StorageService | AlertService> {
	return Effect.gen(function* () {
		if (options.dryRun) {
			yield* Effect.log("youtube.video.would-hold").pipe(
				Effect.annotateLogs({ reason: hold.reason }),
			);
			return;
		}
		const storage = yield* StorageService;
		const { created } = yield* storage.holdVideo({
			bodySlug: body.slug,
			videoId: video.videoId,
			title: video.title,
			...hold,
		});
		if (!created) return;

		yield* Effect.log("youtube.video.held").pipe(
			Effect.annotateLogs({ reason: hold.reason }),
		);
		const alert = yield* AlertService;
		yield* alert
			.sendAlert(
				formatHeldVideoAlert({
					bodyName: body.name,
					videoTitle: video.title,
					videoUrl: videoUrl(video.videoId),
					reason: hold.reason,
					meetingDate: hold.meetingDate,
				}),
			)
			.pipe(Effect.catch(() => Effect.void));
	}).pipe(Effect.annotateLogs({ body: body.slug, videoId: video.videoId }));
}

/** What processing one video needs, whether it came from a playlist or the operator. */
type VideoRef = Pick<YouTubeVideo, "videoId" | "title">;

/** The meeting a video is filed under. */
type VideoMeeting = Pick<MeetingInput, "date" | "session" | "meetingType">;

function processYouTubeVideo(
	body: BodyConfig,
	video: VideoRef,
	videoMeeting: VideoMeeting,
	config: ResolvedConfig,
	dramaAlertScope: "item" | "sole-item" = "item",
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

		yield* Effect.log("youtube.transcribe.start");
		// Disabled captions are a property of the video, so asking again
		// cannot succeed.
		const transcript = yield* transcription.transcribe(video.videoId).pipe(
			Effect.retry({
				schedule: config.networkSchedule,
				while: (error) => error.captionsDisabled !== true,
			}),
		);
		yield* Effect.log("youtube.transcribe.finish").pipe(
			Effect.annotateLogs({ source: transcript.source }),
		);

		yield* Effect.log("youtube.summarize.start");
		const summary = yield* summarizer
			.summarize({
				sources: [{ kind: "transcript", text: transcript.rawText }],
				meetingContext: `${body.name}, ${video.title}`,
			})
			.pipe(Effect.retry(config.llmSchedule));
		yield* Effect.log("youtube.summarize.finish");

		if (config.dryRun) return { processed: 1, errors: 0 };

		const sourceUrl = videoUrl(video.videoId);

		const meeting = yield* storage.storeMeeting({
			bodySlug: body.slug,
			date: videoMeeting.date,
			session: videoMeeting.session,
			meetingType: videoMeeting.meetingType,
			documents: [],
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
				sourceKinds: ["transcript"],
				sourceFingerprint: fingerprintOfSources({
					documents: [],
					transcriptUrl: sourceUrl,
				}),
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
		});

		yield* storage.storeTranscript({
			meetingId: meeting.id,
			source: transcript.source,
			rawText: transcript.rawText,
			segments: transcript.segments,
			sourceUrl,
		});

		// Drama detection runs AFTER transcript storage. Failure must not
		// regress transcript or summary persistence — those are first-class
		// transparency artifacts. The catch below absorbs any error,
		// alerts the operator, and returns Effect.void so the orchestrator's
		// tagged-error channel is unaffected.
		yield* Effect.log("youtube.drama.start");
		yield* runDramaDetection({
			body,
			video,
			meetingId: meeting.id,
			transcript,
		}).pipe(
			Effect.catch((error) => alertDramaFailure(body, error, dramaAlertScope)),
		);
		yield* Effect.log("youtube.drama.finish");

		return { processed: 1, errors: 0 };
	}).pipe(Effect.annotateLogs({ body: body.slug, videoId: video.videoId }));
}

function runDramaDetection(input: {
	body: BodyConfig;
	video: VideoRef;
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

		const categoryScores: Record<DramaCategory, DramaCategoryScoreInput> = {
			procedural_breakdown: { score: 0, evidenceQuotes: [] },
			question_looping: { score: 0, evidenceQuotes: [] },
			defensive_hedging: { score: 0, evidenceQuotes: [] },
			timeline_pressure: { score: 0, evidenceQuotes: [] },
			improvised_workarounds: { score: 0, evidenceQuotes: [] },
			visible_dissent: { score: 0, evidenceQuotes: [] },
			post_hoc_corrections: { score: 0, evidenceQuotes: [] },
		};
		for (const cat of DRAMA_CATEGORIES) {
			categoryScores[cat] = {
				score: assessment.category_scores[cat].score,
				evidenceQuotes: assessment.category_scores[cat].evidence_quotes,
			};
		}

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

function alertDramaFailure(
	body: BodyConfig,
	error: LlmError | DatabaseError,
	scope: AlertScope,
) {
	return Effect.gen(function* () {
		const alert = yield* AlertService;
		yield* alert
			.sendAlert(
				formatPipelineErrorAlert({
					stage: "drama-detection",
					bodyName: body.name,
					errorTag: error._tag,
					errorMessage: error.message,
					scope,
				}),
			)
			.pipe(Effect.catch(() => Effect.void));
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

/** A listing whose title or date cell carries no date the parser can read. */
class UndatedListingError {
	readonly _tag = "UndatedListingError";
	readonly message: string;
	constructor(input: {
		title: string;
		uploadDate: string | null;
	}) {
		const uploaded = input.uploadDate ? ` (uploaded ${input.uploadDate})` : "";
		this.message = `No meeting date could be read from "${input.title}"${uploaded}. The listing was not ingested.`;
	}
}

/** A listing whose type cell has no letters or digits to name its session. */
class UnsessionedListingError {
	readonly _tag = "UnsessionedListingError";
	readonly message: string;
	constructor(input: { title: string }) {
		this.message = `No session could be read from the type cell of "${input.title}". The listing was not ingested.`;
	}
}

type TaggedPipelineError =
	| NetworkError
	| ParseError
	| TranscriptionError
	| LlmError
	| DatabaseError
	| PipelineExtractError
	| UndatedListingError
	| UnsessionedListingError;

function listingFailureStage(error: TaggedPipelineError): string {
	switch (error._tag) {
		case "NetworkError":
			return "download";
		case "ParseError":
			return "extract";
		case "PipelineExtractError":
			return "extract";
		case "UndatedListingError":
			return "date";
		case "UnsessionedListingError":
			return "session";
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
	scope: AlertScope,
): Effect.Effect<void, never, AlertService> {
	return Effect.gen(function* () {
		const alert = yield* AlertService;
		const formatted = formatPipelineErrorAlert({
			stage,
			bodyName: body.name,
			errorTag: error._tag,
			errorMessage: error.message,
			scope,
		});
		yield* alert.sendAlert(formatted).pipe(Effect.catch(() => Effect.void));
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
	video: VideoRef;
	meetingDate: string;
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
		enabledSources: new Set(PIPELINE_SOURCES),
	};

	return processYouTubeVideo(
		input.body,
		input.video,
		{ date: input.meetingDate, session: "", meetingType: "regular" },
		config,
		"sole-item",
	).pipe(
		Effect.catch((error) =>
			Effect.gen(function* () {
				const alert = yield* AlertService;
				yield* alert
					.sendAlert(
						formatPipelineErrorAlert({
							stage: error._tag,
							bodyName: input.body.name,
							errorTag: error._tag,
							errorMessage: error.message,
							scope: "sole-item",
						}),
					)
					.pipe(Effect.catch(() => Effect.void));
				return { processed: 0, errors: 1 };
			}),
		),
	);
}

export {
	holdVideoAndAlert,
	PIPELINE_SOURCES,
	runDramaDetectForVideo,
	runPipeline,
};
export type {
	BodyConfig,
	PipelineSource,
	RunPipelineInput,
	PipelineResult,
	RetryPolicy,
};
