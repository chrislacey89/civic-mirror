import { Duration, Effect } from "effect";
import {
	AlertService,
	formatPipelineErrorAlert,
} from "#/pipeline/services/AlertService.ts";
import type { FinalsiteMeetingListing } from "#/pipeline/services/FinalsiteScraper.ts";
import { FinalsiteScraper } from "#/pipeline/services/FinalsiteScraper.ts";
import type { EgovDocumentListing } from "#/pipeline/services/ScraperService.ts";
import { EgovScraper } from "#/pipeline/services/ScraperService.ts";
import type { MeetingInput } from "#/pipeline/services/StorageService.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import { TranscriptionService } from "#/pipeline/services/TranscriptionService.ts";
import type { YouTubeVideo } from "#/pipeline/services/YouTubeScraper.ts";
import { YouTubeScraper } from "#/pipeline/services/YouTubeScraper.ts";

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

type BodyConfig = {
	slug: string;
	name: string;
	/** eGov document-center search type id (e.g. "12" for minutes). */
	egovSearchType?: string;
	/** Full Finalsite page URL (e.g. https://www.rbbschools.net/school-board). */
	finalsiteUrl?: string;
	/** YouTube playlist ID for the body's meeting recordings. */
	youtubePlaylistId?: string;
};

type RunPipelineInput = {
	bodies: BodyConfig[];
	/** Milliseconds to sleep between eGov document downloads. Production: 300_000. */
	crawlDelayMs: number;
	/** Converts a downloaded PDF (ArrayBuffer) into plain text. */
	extractPdfText: (bytes: ArrayBuffer) => Promise<string>;
	/** When true, run all stages except storage and alerts — for smoke-testing. */
	dryRun: boolean;
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
> {
	return Effect.gen(function* () {
		let processed = 0;
		let errors = 0;

		for (const body of input.bodies) {
			const bodyResult = yield* runPipelineForBody(body, input);
			processed += bodyResult.processed;
			errors += bodyResult.errors;
		}

		return { processed, errors };
	});
}

function runPipelineForBody(
	body: BodyConfig,
	config: RunPipelineInput,
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
> {
	return Effect.gen(function* () {
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
// eGov path
// ---------------------------------------------------------------------------

function runEgovForBody(
	body: BodyConfig & { egovSearchType?: string },
	config: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	never,
	EgovScraper | SummarizationService | StorageService | AlertService
> {
	return Effect.gen(function* () {
		const searchType = body.egovSearchType;
		if (!searchType) return { processed: 0, errors: 0 };

		const scraper = yield* EgovScraper;

		const listingsResult = yield* scraper
			.scrapeListings({ searchType, page: 1 })
			.pipe(
				Effect.map((listings) => ({ ok: true as const, listings })),
				Effect.catchAll((error) =>
					alertAndRecover(body, "scrape", error).pipe(
						Effect.as({ ok: false as const }),
					),
				),
			);

		if (!listingsResult.ok) return { processed: 0, errors: 1 };

		let processed = 0;
		let errors = 0;

		for (const listing of listingsResult.listings) {
			const perListing = yield* processEgovListing(body, listing, config).pipe(
				Effect.catchAll((error) =>
					alertAndRecover(body, listingFailureStage(error), error).pipe(
						Effect.as({ processed: 0, errors: 1 }),
					),
				),
			);

			processed += perListing.processed;
			errors += perListing.errors;

			if (config.crawlDelayMs > 0) {
				yield* Effect.sleep(Duration.millis(config.crawlDelayMs));
			}
		}

		return { processed, errors };
	});
}

function processEgovListing(
	body: BodyConfig,
	listing: EgovDocumentListing,
	config: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	TaggedPipelineError,
	EgovScraper | SummarizationService | StorageService
> {
	return Effect.gen(function* () {
		const scraper = yield* EgovScraper;
		const summarizer = yield* SummarizationService;
		const storage = yield* StorageService;

		const bytes = yield* scraper.downloadDocument(listing.downloadUrl);
		const text = yield* Effect.tryPromise({
			try: () => config.extractPdfText(bytes),
			catch: (error) =>
				new PipelineExtractError({
					message: error instanceof Error ? error.message : String(error),
				}),
		});

		const summary = yield* summarizer.summarize({
			sourceText: text,
			meetingContext: `${body.name}, ${listing.date}`,
		});

		if (config.dryRun) return { processed: 1, errors: 0 };

		const meetingInput: MeetingInput = {
			bodySlug: body.slug,
			date: normalizeEgovDate(listing.date),
			meetingType: "regular",
			documents: [
				{
					sourceUrl: listing.downloadUrl,
					rawText: text,
					documentType: "minutes",
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
	config: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	never,
	FinalsiteScraper | SummarizationService | StorageService | AlertService
> {
	return Effect.gen(function* () {
		const scraper = yield* FinalsiteScraper;

		const listingsResult = yield* scraper.scrapeListings().pipe(
			Effect.map((listings) => ({ ok: true as const, listings })),
			Effect.catchAll((error) =>
				alertAndRecover(body, "scrape", error).pipe(
					Effect.as({ ok: false as const }),
				),
			),
		);

		if (!listingsResult.ok) return { processed: 0, errors: 1 };

		let processed = 0;
		let errors = 0;

		for (const listing of listingsResult.listings) {
			if (listing.documents.length === 0) continue;

			const perListing = yield* processFinalsiteListing(
				body,
				listing,
				config,
			).pipe(
				Effect.catchAll((error) =>
					alertAndRecover(body, listingFailureStage(error), error).pipe(
						Effect.as({ processed: 0, errors: 1 }),
					),
				),
			);

			processed += perListing.processed;
			errors += perListing.errors;
		}

		return { processed, errors };
	});
}

function processFinalsiteListing(
	body: BodyConfig,
	listing: FinalsiteMeetingListing,
	config: RunPipelineInput,
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
			const bytes = yield* scraper.downloadDocument(doc.uuid);
			const text = yield* Effect.tryPromise({
				try: () => config.extractPdfText(bytes),
				catch: (error) =>
					new PipelineExtractError({
						message: error instanceof Error ? error.message : String(error),
					}),
			});
			documents.push({
				sourceUrl: doc.downloadUrl,
				rawText: text,
				documentType:
					doc.documentType === "notice" ? "agenda" : doc.documentType,
			});
			combinedText += `\n${text}`;
		}

		const summary = yield* summarizer.summarize({
			sourceText: combinedText,
			meetingContext: `${body.name}, ${listing.date}`,
		});

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
	config: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	never,
	| YouTubeScraper
	| TranscriptionService
	| SummarizationService
	| StorageService
	| AlertService
> {
	return Effect.gen(function* () {
		const playlistId = body.youtubePlaylistId;
		if (!playlistId) return { processed: 0, errors: 0 };

		const scraper = yield* YouTubeScraper;

		const videosResult = yield* scraper.listPlaylistVideos(playlistId).pipe(
			Effect.map((videos) => ({ ok: true as const, videos })),
			Effect.catchAll((error) =>
				alertAndRecover(body, "scrape", error).pipe(
					Effect.as({ ok: false as const }),
				),
			),
		);

		if (!videosResult.ok) return { processed: 0, errors: 1 };

		let processed = 0;
		let errors = 0;

		for (const video of videosResult.videos) {
			const perVideo = yield* processYouTubeVideo(body, video, config).pipe(
				Effect.catchAll((error) =>
					alertAndRecover(body, listingFailureStage(error), error).pipe(
						Effect.as({ processed: 0, errors: 1 }),
					),
				),
			);

			processed += perVideo.processed;
			errors += perVideo.errors;
		}

		return { processed, errors };
	});
}

function processYouTubeVideo(
	body: BodyConfig,
	video: YouTubeVideo,
	config: RunPipelineInput,
): Effect.Effect<
	PipelineResult,
	TaggedPipelineError,
	TranscriptionService | SummarizationService | StorageService
> {
	return Effect.gen(function* () {
		const transcription = yield* TranscriptionService;
		const summarizer = yield* SummarizationService;
		const storage = yield* StorageService;

		const transcript = yield* transcription.transcribe(video.videoId);
		const summary = yield* summarizer.summarize({
			sourceText: transcript.rawText,
			meetingContext: `${body.name}, ${video.title}`,
		});

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

		return { processed: 1, errors: 0 };
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
// Date normalization
// ---------------------------------------------------------------------------

/** Converts eGov "MM/DD/YYYY" to ISO "YYYY-MM-DD". */
function normalizeEgovDate(mmddyyyy: string): string {
	const parts = mmddyyyy.split("/");
	if (parts.length !== 3) return mmddyyyy;
	const [month, day, year] = parts;
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

const MONTHS: Record<string, string> = {
	january: "01",
	february: "02",
	march: "03",
	april: "04",
	may: "05",
	june: "06",
	july: "07",
	august: "08",
	september: "09",
	october: "10",
	november: "11",
	december: "12",
};

/** Converts Finalsite "Month Day, Year" (e.g. "January 6, 2026") to ISO. */
function normalizeFinalsiteDate(label: string, year: number): string {
	const match = label.match(/^(\w+)\s+(\d+),?\s*(\d+)?$/);
	if (!match) return `${year}-01-01`;
	const monthName = match[1].toLowerCase();
	const day = match[2].padStart(2, "0");
	const parsedYear = match[3] ? Number(match[3]) : year;
	const month = MONTHS[monthName] ?? "01";
	return `${parsedYear}-${month}-${day}`;
}

function meetingTypeFromFinalsiteLabel(
	label: string,
): "regular" | "special" | "workshop" {
	const lower = label.toLowerCase();
	if (lower.includes("special")) return "special";
	if (lower.includes("workshop")) return "workshop";
	return "regular";
}

export { runPipeline };
export type { BodyConfig, RunPipelineInput, PipelineResult };
