import { Clock, Duration, Effect, Layer, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import {
	getMeetingByBodyAndDateQuery,
	type MeetingDetail,
} from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";
import type { ScoredDramaCategory } from "#/lib/drama-levels.ts";
import {
	DatabaseError,
	LlmError,
	MeetingMatchError,
	NetworkError,
	TranscriptionError,
} from "#/pipeline/errors.ts";
import {
	holdVideoAndAlert,
	runDramaDetectForVideo,
	runPipeline,
	videoIdFromUrl,
	videoUrl,
} from "#/pipeline/orchestrator.ts";
import { AlertService } from "#/pipeline/services/AlertService.ts";
import {
	type DramaAssessmentResult,
	DramaDetectionService,
} from "#/pipeline/services/DramaDetectionService.ts";
import type { FinalsiteMeetingListing } from "#/pipeline/services/FinalsiteScraper.ts";
import { FinalsiteScraper } from "#/pipeline/services/FinalsiteScraper.ts";
import {
	type MatchableSummary,
	type MatchResult,
	type MeetingMatchInput,
	MeetingMatchService,
} from "#/pipeline/services/MeetingMatchService.ts";
import type { EgovDocumentListing } from "#/pipeline/services/ScraperService.ts";
import { EgovScraper } from "#/pipeline/services/ScraperService.ts";
import type {
	DramaCategoryScoreInput,
	HeldVideoInput,
	Meeting,
	MeetingInput,
	MeetingSourceState,
	MeetingSources,
} from "#/pipeline/services/StorageService.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import type {
	SummarizationInput,
	SummarizationResult,
} from "#/pipeline/services/SummarizationService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import {
	TranscriptionService,
	type TranscriptResult,
} from "#/pipeline/services/TranscriptionService.ts";
import type { YouTubeVideo } from "#/pipeline/services/YouTubeScraper.ts";
import { YouTubeScraper } from "#/pipeline/services/YouTubeScraper.ts";
import { computeSourceFingerprint } from "#/pipeline/sources.ts";
import { createMigratedTestDb } from "#/pipeline/test-db.ts";

/**
 * Test helpers — build stub Effect Layers for each service. Each stub records
 * calls in a closure so tests can assert on what the orchestrator did.
 */

type CallLog = {
	egovScrape: number;
	egovDownload: Array<string>;
	finalsiteScrape: number;
	finalsiteDownload: Array<string>;
	youtubeList: Array<string>;
	transcribe: Array<string>;
	summarize: Array<SummarizationInput>;
	store: Array<{ bodySlug: string; date: string }>;
	storeInputs: Array<MeetingInput>;
	transcripts: Array<{ meetingId: number; sourceUrl?: string }>;
	alert: Array<{ subject: string; body: string }>;
	drama: number;
	/** The `sourceText` each drama detection call received. */
	dramaSourceTexts: Array<string>;
	/** Videos the storage stub was asked to hold and did not already hold. */
	held: Array<HeldVideoInput>;
	match: Array<MeetingMatchInput>;
	/** Summary replacements, by meeting. */
	replaced: Array<{ meetingId: number; sourceKinds: string[] }>;
	/** Meetings a drama assessment was stored for. */
	dramaStored: Array<number>;
	/** Meetings whose summary was stamped with a fingerprint. */
	stamped: Array<number>;
};

function emptyCallLog(): CallLog {
	return {
		egovScrape: 0,
		egovDownload: [],
		finalsiteScrape: 0,
		finalsiteDownload: [],
		youtubeList: [],
		transcribe: [],
		summarize: [],
		store: [],
		storeInputs: [],
		transcripts: [],
		alert: [],
		drama: 0,
		dramaSourceTexts: [],
		held: [],
		match: [],
		replaced: [],
		dramaStored: [],
		stamped: [],
	};
}

type StubConfig = {
	log: CallLog;
	egovListings?: EgovDocumentListing[];
	egovScrapeError?: NetworkError;
	finalsiteListings?: FinalsiteMeetingListing[];
	youtubeVideos?: YouTubeVideo[];
	summarizationResult?: SummarizationResult;
	summarizationError?: Error;
	/** Fails only the summarize calls it returns true for. */
	summarizationFailsWhen?: (input: SummarizationInput) => boolean;
	storedMeeting?: Meeting;
	lastMeetingLookup?: MeetingDetail | null;
	mostRecentMeetingDate?: string | null;
	/** What storage already holds for a `(date, session)`; nothing by default. */
	meetingSourceState?: (key: {
		date: string;
		session: string;
	}) => MeetingSourceState | null;
	/**
	 * The existing meeting's stored summary, as the same-meeting check reads
	 * it. A documents summary by default; null models a meeting with none.
	 */
	matchableSummary?: MatchableSummary | null;
	/** Documents-only meetings near a date that has no meeting of its own. */
	nearbyMeetings?: MeetingSourceState[];
	/** Every source the existing meeting holds; none by default. */
	meetingSources?: MeetingSources;
	/** What the same-meeting check answers; a match by default. */
	matchResult?: MatchResult | MeetingMatchError;
	/** Video URLs storage already holds a transcript for. */
	storedVideoUrls?: string[];
	/** Videos whose transcription fails, by video ID. */
	transcriptionErrors?: Record<string, TranscriptionError>;
	/** Replaces the default transcript, by video ID. */
	transcripts?: Record<string, TranscriptResult>;
	/** Video IDs storage already holds as held videos. */
	heldVideoIds?: string[];
	/** Replaces the storage stub, for tests that run against a real database. */
	storage?: Layer.Layer<StorageService>;
	dramaDetectionResult?: DramaAssessmentResult;
	dramaDetectionError?: Error;
};

function buildStubLayers(config: StubConfig) {
	const defaultSummary: SummarizationResult = {
		highlights: ["A highlight"],
		prose: "A prose summary",
		fiscalDecisions: [],
		budgetDiscussions: [],
		sourceDisagreements: [],
		model: "stub-model",
	};
	const defaultMeeting: Meeting = { id: 1, date: "2026-01-01", bodyId: 1 };

	const egov = Layer.succeed(EgovScraper, {
		scrapeListings: () =>
			Effect.suspend(() => {
				config.log.egovScrape += 1;
				return config.egovScrapeError
					? Effect.fail(config.egovScrapeError)
					: Effect.succeed(config.egovListings ?? []);
			}),
		downloadDocument: (url) =>
			Effect.sync(() => {
				config.log.egovDownload.push(url);
				return new TextEncoder().encode("fake pdf").buffer as ArrayBuffer;
			}),
	});

	const finalsite = Layer.succeed(FinalsiteScraper, {
		scrapeListings: () =>
			Effect.sync(() => {
				config.log.finalsiteScrape += 1;
				return config.finalsiteListings ?? [];
			}),
		downloadDocument: (uuid) =>
			Effect.sync(() => {
				config.log.finalsiteDownload.push(uuid);
				return new TextEncoder().encode("fake pdf").buffer as ArrayBuffer;
			}),
	});

	const youtube = Layer.succeed(YouTubeScraper, {
		listPlaylistVideos: (playlistId) =>
			Effect.sync(() => {
				config.log.youtubeList.push(playlistId);
				return config.youtubeVideos ?? [];
			}),
	});

	const transcription = Layer.succeed(TranscriptionService, {
		transcribe: (videoId) =>
			Effect.suspend(() => {
				config.log.transcribe.push(videoId);
				const error = config.transcriptionErrors?.[videoId];
				if (error) return Effect.fail(error);
				const transcript = config.transcripts?.[videoId];
				if (transcript) return Effect.succeed(transcript);
				return Effect.succeed({
					source: "captions" as const,
					rawText: `transcript for ${videoId}`,
					segments: [],
				});
			}),
	});

	const summarization = Layer.succeed(SummarizationService, {
		summarize: (input) =>
			Effect.try({
				try: () => {
					config.log.summarize.push(input);
					if (config.summarizationError) {
						throw config.summarizationError;
					}
					if (config.summarizationFailsWhen?.(input)) {
						throw new Error("summarizer unavailable");
					}
					return config.summarizationResult ?? defaultSummary;
				},
				catch: (error) =>
					new LlmError({
						model: "stub-model",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});

	const isHeld = (videoId: string) =>
		(config.heldVideoIds ?? []).includes(videoId) ||
		config.log.held.some((h) => h.videoId === videoId);

	const storage = Layer.succeed(StorageService, {
		storeMeeting: (input) =>
			Effect.sync(() => {
				config.log.store.push({ bodySlug: input.bodySlug, date: input.date });
				config.log.storeInputs.push(input);
				return config.storedMeeting ?? defaultMeeting;
			}),
		getMeetingByBodyAndDate: () =>
			Effect.sync(() => config.lastMeetingLookup ?? null),
		storeTranscript: (input) =>
			Effect.sync(() => {
				config.log.transcripts.push({
					meetingId: input.meetingId,
					sourceUrl: input.sourceUrl,
				});
			}),
		getMostRecentMeetingDate: () =>
			Effect.sync(() => config.mostRecentMeetingDate ?? null),
		storeDramaAssessment: (input) =>
			Effect.sync(() => {
				config.log.dramaStored.push(input.meetingId);
			}),
		getMeetingSourceState: (key) =>
			Effect.sync(() => config.meetingSourceState?.(key) ?? null),
		findNearbyDocumentOnlyMeetings: () =>
			Effect.sync(() => config.nearbyMeetings ?? []),
		getMatchableSummary: () =>
			Effect.sync(() =>
				config.matchableSummary === undefined
					? {
							highlights: ["Approved Ordinance 2025-12"],
							prose: "The council approved Ordinance 2025-12.",
							fiscalDecisions: [],
						}
					: config.matchableSummary,
			),
		hasTranscriptForVideo: (sourceUrl) =>
			Effect.sync(() => (config.storedVideoUrls ?? []).includes(sourceUrl)),
		holdVideo: (input) =>
			Effect.sync(() => {
				if (isHeld(input.videoId)) return { created: false };
				config.log.held.push(input);
				return { created: true };
			}),
		isVideoHeld: (videoId) => Effect.sync(() => isHeld(videoId)),
		listHeldVideos: () => Effect.succeed([]),
		listCombinedSummaryMeetings: () => Effect.succeed([]),
		getMeetingSources: () =>
			Effect.sync(
				() =>
					config.meetingSources ?? {
						documents: [],
						transcript: null,
						summary: null,
					},
			),
		replaceMeetingSummary: (input) =>
			Effect.sync(() => {
				config.log.replaced.push({
					meetingId: input.meetingId,
					sourceKinds: input.sourceKinds,
				});
			}),
		stampSummarySources: (input) =>
			Effect.sync(() => {
				config.log.stamped.push(input.meetingId);
			}),
		detachTranscript: () => Effect.succeed(null),
		detachDocument: () => Effect.succeed(false),
	});

	const meetingMatch = Layer.succeed(MeetingMatchService, {
		check: (input) =>
			Effect.suspend(() => {
				config.log.match.push(input);
				const result = config.matchResult ?? {
					outcome: "match" as const,
					probability: 0.9,
					sharedIdentifiers: 2,
				};
				return result instanceof MeetingMatchError
					? Effect.fail(result)
					: Effect.succeed(result);
			}),
	});

	const alert = Layer.succeed(AlertService, {
		sendAlert: (input) =>
			Effect.sync(() => {
				config.log.alert.push(input);
			}),
	});

	const defaultDramaResult: DramaAssessmentResult = {
		category_scores: {
			procedural_breakdown: { score: 0, evidence_quotes: [] },
			question_looping: { score: 0, evidence_quotes: [] },
			unanswered_questions: { score: 0, evidence_quotes: [] },
			undecided_time: { score: 0, evidence_quotes: [] },
			improvised_workarounds: { score: 0, evidence_quotes: [] },
			repeat_deferrals: { score: 0, evidence_quotes: [] },
			post_hoc_corrections: { score: 0, evidence_quotes: [] },
		},
		level: "routine",
		confidence: 0.8,
		headline: "Routine meeting",
		narrative: "Nothing notable.",
		model: "stub-model",
		promptVersion: "v1",
	};

	const drama = Layer.succeed(DramaDetectionService, {
		detect: (input) =>
			Effect.try({
				try: () => {
					config.log.drama += 1;
					config.log.dramaSourceTexts.push(input.sourceText);
					if (config.dramaDetectionError) throw config.dramaDetectionError;
					return config.dramaDetectionResult ?? defaultDramaResult;
				},
				catch: (error) =>
					new LlmError({
						model: "stub-model",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});

	return Layer.mergeAll(
		egov,
		finalsite,
		youtube,
		transcription,
		summarization,
		config.storage ?? storage,
		meetingMatch,
		alert,
		drama,
	);
}

/**
 * Runs `program` under a clock whose sleeps return at once, recording each
 * requested duration in milliseconds so a test can assert on pacing without
 * waiting for it.
 */
function withRecordedSleeps<A, E, R>(program: Effect.Effect<A, E, R>) {
	const sleeps: number[] = [];
	const effect = Clock.clockWith((live) =>
		program.pipe(
			Effect.provideService(Clock.Clock, {
				currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
				currentTimeMillis: live.currentTimeMillis,
				currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
				currentTimeNanos: live.currentTimeNanos,
				monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: live.monotonicTimeNanos,
				sleep: (duration) =>
					Effect.sync(() => {
						sleeps.push(Duration.toMillis(duration));
					}),
			}),
		),
	);
	return { sleeps, effect };
}

describe("runPipeline", () => {
	it("processes an eGov body end to end, storing one meeting per listing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1653,
					title: "Town Council Meeting February 4, 2026 Minutes",
					date: "02/04/2026",
					downloadUrl: "https://example.com/doc/1653",
					meetingDate: "2026-02-04",
					documentType: "minutes",
				},
				{
					id: 1628,
					title: "Town Council Meeting January 14, 2026 Minutes",
					date: "01/14/2026",
					downloadUrl: "https://example.com/doc/1628",
					meetingDate: "2026-01-14",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					egovSearchType: "12",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "Meeting minutes body text with $50,000 decision",
				method: "text-layer",
			}),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.egovScrape).toBe(1);
		expect(log.egovDownload).toHaveLength(2);
		expect(log.summarize).toHaveLength(2);
		expect(log.summarize[0].sources[0].text).toContain("$50,000");
		expect(log.store).toHaveLength(2);
		expect(log.store[0].bodySlug).toBe("town-council");
		expect(log.alert).toHaveLength(0);
		expect(result.processed).toBe(2);
		expect(result.errors).toBe(0);
	});

	it("stores eGov meetings under the title-derived meetingDate, not the publish-date cell", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				// Publish date (table cell) is 01/14/2026 — the real meeting date
				// from the title is December 22, 2025. The orchestrator must store
				// under the title-derived date so distinct meetings published in
				// the same batch don't collapse. See issue #27.
				{
					id: 1628,
					title: "Town Council Meeting Minutes December 22, 2025",
					date: "01/14/2026",
					downloadUrl: "https://example.com/doc/1628",
					meetingDate: "2025-12-22",
					documentType: "minutes",
				},
				{
					id: 1627,
					title: "Town Council Meeting Minutes December 8, 2025",
					date: "01/14/2026",
					downloadUrl: "https://example.com/doc/1627",
					meetingDate: "2025-12-08",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		const storedDates = log.store.map((s) => s.date).sort();
		expect(storedDates).toEqual(["2025-12-08", "2025-12-22"]);
		// The summarizer is told the meeting date too, not the upload date.
		expect(log.summarize.map((s) => s.meetingContext)).toEqual([
			"Body, 2025-12-22",
			"Body, 2025-12-08",
		]);
		// Propagates documentType from the listing into the stored MeetingInput.
		for (const stored of log.storeInputs) {
			expect(stored.documents[0].documentType).toBe("minutes");
		}
	});

	it("holds an eGov listing whose title has no readable date and alerts instead of filing it under the upload date", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 42,
					title: "Town Council Annual Report",
					date: "03/15/2026",
					downloadUrl: "https://example.com/doc/42",
					meetingDate: null,
					documentType: "minutes",
				},
				{
					id: 43,
					title: "Town Council Meeting Minutes 03-09-26",
					date: "03/15/2026",
					downloadUrl: "https://example.com/doc/43",
					meetingDate: "2026-03-09",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// The undated listing is never downloaded, summarized or stored; the
		// dated one behind it still goes through.
		expect(log.egovDownload).toEqual(["https://example.com/doc/43"]);
		expect(log.store.map((s) => s.date)).toEqual(["2026-03-09"]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("Town Council Annual Report");
		expect(log.alert[0].body).toContain("03/15/2026");
		expect(log.alert[0].body).not.toContain("this body was skipped");
		expect(result).toEqual({ processed: 1, errors: 1 });
	});

	it("holds an eGov listing whose document opens with a different date than its title and alerts instead of filing it under the title's date", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1582,
					title: "Town Council Meeting Minutes August 25, 2025",
					date: "09/30/2025",
					downloadUrl: "https://example.com/doc/1582",
					meetingDate: "2025-08-25",
					documentType: "minutes",
				},
				{
					id: 1619,
					title: "Town Council Meeting Minutes August 25, 2025",
					date: "10/20/2025",
					downloadUrl: "https://example.com/doc/1619",
					meetingDate: "2025-08-25",
					documentType: "minutes",
				},
			],
		});
		const texts = [
			"July 28, 2025 _— ee The Ellettsville, Indiana Town Council met for a regular meeting on Monday, July 28, 2025. The Council awarded the bridge bid.",
			"August 25, 2025 -_ The Ellettsville, Indiana Town Council met for a regular meeting on Monday, August 25, 2025. The minutes of July 28, 2025 were approved.",
		];

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: texts[log.egovDownload.length - 1],
				method: "text-layer",
			}),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// The misdated document is downloaded, which is how its date is read,
		// but never summarized or stored. The one behind it still goes through.
		expect(log.egovDownload).toEqual([
			"https://example.com/doc/1582",
			"https://example.com/doc/1619",
		]);
		expect(log.summarize.map((s) => s.sources[0].text)).toEqual([texts[1]]);
		expect(log.store.map((s) => s.date)).toEqual(["2025-08-25"]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain(
			"Town Council Meeting Minutes August 25, 2025",
		);
		expect(log.alert[0].body).toContain("2025-07-28");
		expect(result).toEqual({ processed: 1, errors: 1 });
	});

	it("spends the crawl delay only on the eGov listing it downloaded, not on one held for its date", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 42,
					title: "Town Council Annual Report",
					date: "03/15/2026",
					downloadUrl: "https://example.com/doc/42",
					meetingDate: null,
					documentType: "minutes",
				},
				{
					id: 43,
					title: "Town Council Meeting Minutes 03-09-26",
					date: "03/15/2026",
					downloadUrl: "https://example.com/doc/43",
					meetingDate: "2026-03-09",
					documentType: "minutes",
				},
			],
		});

		const { sleeps, effect } = withRecordedSleeps(
			runPipeline({
				bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
				crawlDelayMs: 300_000,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "text", method: "text-layer" }),
				dryRun: false,
			}).pipe(Effect.provide(layers)),
		);

		const result = await Effect.runPromise(effect);

		expect(result).toEqual({ processed: 1, errors: 1 });
		expect(log.egovDownload).toEqual(["https://example.com/doc/43"]);
		expect(sleeps).toEqual([300_000]);
	});

	it("still spends the crawl delay on an eGov listing that was downloaded and then failed", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 43,
					title: "Town Council Meeting Minutes 03-09-26",
					date: "03/15/2026",
					downloadUrl: "https://example.com/doc/43",
					meetingDate: "2026-03-09",
					documentType: "minutes",
				},
			],
			summarizationError: new Error("LLM boom"),
		});

		const { sleeps, effect } = withRecordedSleeps(
			runPipeline({
				bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
				crawlDelayMs: 300_000,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "text", method: "text-layer" }),
				dryRun: false,
			}).pipe(Effect.provide(layers)),
		);

		const result = await Effect.runPromise(effect);

		// The listing failed, but only after its document was requested from
		// the portal, so the request still has to be paced.
		expect(result).toEqual({ processed: 0, errors: 1 });
		expect(log.egovDownload).toEqual(["https://example.com/doc/43"]);
		expect(log.store).toHaveLength(0);
		expect(sleeps).toEqual([300_000]);
	});

	it("skips storage and alerts in dry-run mode but still scrapes and summarizes", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1,
					title: "Meeting",
					date: "01/01/2026",
					downloadUrl: "https://example.com/doc/1",
					meetingDate: "2026-01-01",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: true,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.egovDownload).toHaveLength(1);
		expect(log.summarize).toHaveLength(1);
		expect(log.store).toHaveLength(0);
		expect(result.processed).toBe(1);
	});

	it("filters eGov listings by egovTitlePattern so bodies sharing a searchType only ingest their own rows", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1628,
					title: "Town Council Meeting Minutes December 22, 2025",
					date: "12/22/2025",
					downloadUrl: "https://example.com/doc/1628",
					meetingDate: "2025-12-22",
					documentType: "minutes",
				},
				{
					id: 1653,
					title:
						"Reorganization Board Meeting February 4, 2026 Minutes Approved",
					date: "02/04/2026",
					downloadUrl: "https://example.com/doc/1653",
					meetingDate: "2026-02-04",
					documentType: "minutes",
				},
				{
					id: 1627,
					title: "Town Council Meeting Minutes December 8, 2025",
					date: "12/08/2025",
					downloadUrl: "https://example.com/doc/1627",
					meetingDate: "2025-12-08",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "ellettsville-town-council",
					name: "Ellettsville Town Council",
					egovSearchType: "12",
					egovTitlePattern: /^Town Council/i,
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.egovDownload).toEqual([
			"https://example.com/doc/1628",
			"https://example.com/doc/1627",
		]);
		expect(log.store).toHaveLength(2);
		expect(
			log.store.every((s) => s.bodySlug === "ellettsville-town-council"),
		).toBe(true);
		expect(log.alert).toHaveLength(0);
		expect(result.processed).toBe(2);
		expect(result.errors).toBe(0);
	});

	it("catches a per-listing error, sends an alert, and continues with the next listing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1,
					title: "First",
					date: "01/01/2026",
					downloadUrl: "https://example.com/doc/1",
					meetingDate: "2026-01-01",
					documentType: "minutes",
				},
				{
					id: 2,
					title: "Second",
					date: "01/02/2026",
					downloadUrl: "https://example.com/doc/2",
					meetingDate: "2026-01-02",
					documentType: "minutes",
				},
			],
			summarizationError: new Error("LLM boom"),
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.summarize).toHaveLength(2);
		expect(log.store).toHaveLength(0);
		expect(log.alert.length).toBeGreaterThanOrEqual(1);
		expect(log.alert[0].subject).toContain("summarize");
		expect(result.errors).toBe(2);
	});

	it("alerts that the whole body was skipped when its listings cannot be fetched", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovScrapeError: new NetworkError({
				url: "https://example.com/listings",
				message: "portal unreachable",
			}),
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(result).toEqual({ processed: 0, errors: 1 });
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("portal unreachable");
		expect(log.alert[0].body).toContain("this body was skipped");
	});

	it("retries a failing LLM call exactly `attempts` more times before giving up", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1,
					title: "First",
					date: "01/01/2026",
					downloadUrl: "https://example.com/doc/1",
					meetingDate: "2026-01-01",
					documentType: "minutes",
				},
			],
			summarizationError: new Error("LLM boom"),
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 2, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// RetryPolicy.attempts is "additional attempts beyond the first":
		// 1 initial call + 2 retries.
		expect(log.summarize).toHaveLength(3);
		expect(log.store).toHaveLength(0);
		expect(result.errors).toBe(1);
	});

	it("processes a Finalsite body: one listing per document per meeting", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "January 20, 2026",
					meetingType: "Regular Meeting",
					year: 2026,
					documents: [
						{
							uuid: "uuid-agenda",
							documentType: "agenda",
							downloadUrl: "/fs/resource-manager/view/uuid-agenda",
							fileName: "agenda.pdf",
						},
						{
							uuid: "uuid-minutes",
							documentType: "minutes",
							downloadUrl: "/fs/resource-manager/view/uuid-minutes",
							fileName: "minutes.pdf",
						},
					],
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "school board text",
				method: "text-layer",
			}),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.finalsiteDownload).toHaveLength(2);
		expect(log.store).toHaveLength(1);
		expect(log.store[0].bodySlug).toBe("school-board");
		expect(result.processed).toBe(1);
	});

	it("stores two same-named Finalsite rows that share a date under sessions told apart by start time", async () => {
		const log = emptyCallLog();
		const row = (meetingType: string, uuid: string) => ({
			date: "September 21, 2020",
			meetingType,
			year: 2020,
			documents: [
				{
					uuid,
					documentType: "minutes" as const,
					downloadUrl: `/fs/resource-manager/view/${uuid}`,
					fileName: `${uuid}.pdf`,
				},
			],
		});
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				row("Public Hearing 4:00 PM", "uuid-afternoon"),
				row("Public Hearing 7:00 PM", "uuid-evening"),
			],
		});

		await Effect.runPromise(
			runPipeline({
				bodies: [
					{
						slug: "school-board",
						name: "School Board",
						finalsiteUrl: "https://example.com/school-board",
					},
				],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({
					text: "school board text",
					method: "text-layer",
				}),
				dryRun: false,
			}).pipe(Effect.provide(layers)),
		);

		expect(log.storeInputs.map((i) => [i.date, i.session])).toEqual([
			["2020-09-21", "public-hearing-4-00-pm"],
			["2020-09-21", "public-hearing-7-00-pm"],
		]);
		expect(log.storeInputs[0].session).not.toBe(log.storeInputs[1].session);
	});

	it("holds a Finalsite listing whose date cell is unreadable and alerts instead of filing it under a guessed date", async () => {
		const log = emptyCallLog();
		const doc = (uuid: string) => ({
			uuid,
			documentType: "minutes" as const,
			downloadUrl: `/fs/resource-manager/view/${uuid}`,
			fileName: `${uuid}.pdf`,
		});
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "Sept 8, 2025",
					meetingType: "Regular Meeting",
					year: 2025,
					documents: [doc("uuid-undated")],
				},
				{
					date: "January 20, 2026",
					meetingType: "Regular Meeting",
					year: 2026,
					documents: [doc("uuid-dated")],
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.finalsiteDownload).toEqual(["uuid-dated"]);
		expect(log.store.map((s) => s.date)).toEqual(["2026-01-20"]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("Sept 8, 2025");
		expect(result).toEqual({ processed: 1, errors: 1 });
	});

	it("holds a Finalsite listing whose type cell has no letters or digits and alerts instead of filing it under the shared session", async () => {
		const log = emptyCallLog();
		const row = (meetingType: string, uuid: string) => ({
			date: "January 20, 2026",
			meetingType,
			year: 2026,
			documents: [
				{
					uuid,
					documentType: "minutes" as const,
					downloadUrl: `/fs/resource-manager/view/${uuid}`,
					fileName: `${uuid}.pdf`,
				},
			],
		});
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				row("", "uuid-blank"),
				row(" - ", "uuid-punctuation"),
				row("Regular Meeting 6:10 PM", "uuid-regular"),
			],
		});

		const result = await Effect.runPromise(
			runPipeline({
				bodies: [
					{
						slug: "school-board",
						name: "School Board",
						finalsiteUrl: "https://example.com/school-board",
					},
				],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "text", method: "text-layer" }),
				dryRun: false,
			}).pipe(Effect.provide(layers)),
		);

		expect(log.finalsiteDownload).toEqual(["uuid-regular"]);
		expect(log.storeInputs.map((i) => i.session)).toEqual([
			"regular-meeting-6-10-pm",
		]);
		expect(log.alert).toHaveLength(2);
		expect(result).toEqual({ processed: 1, errors: 2 });
	});

	it("skips a Finalsite listing whose date cell is a month and year without alerting", async () => {
		const log = emptyCallLog();
		const doc = (uuid: string) => ({
			uuid,
			documentType: "notice" as const,
			downloadUrl: `/fs/resource-manager/view/${uuid}`,
			fileName: `${uuid}.pdf`,
		});
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "September 2025",
					meetingType: "Superintendent's Contract",
					year: 2025,
					documents: [doc("uuid-month-only")],
				},
				{
					date: "January 20, 2026",
					meetingType: "Regular Meeting",
					year: 2026,
					documents: [doc("uuid-dated")],
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.finalsiteDownload).toEqual(["uuid-dated"]);
		expect(log.store.map((s) => s.date)).toEqual(["2026-01-20"]);
		expect(log.alert).toHaveLength(0);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("sends a zero-results alert when the body's last meeting is more than 30 days old", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			mostRecentMeetingDate: "2026-01-01", // ~99 days before 2026-04-10
			egovListings: [],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "sleepy-body",
					name: "Sleepy Body",
					egovSearchType: "12",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: true,
			now: new Date("2026-04-10T00:00:00Z"),
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		const zeroAlert = log.alert.find((a) =>
			a.subject.includes("No new content"),
		);
		expect(zeroAlert).toBeDefined();
		expect(zeroAlert?.body).toContain("Sleepy Body");
		// 2026-04-10 minus 2026-01-01 = 99 days
		expect(zeroAlert?.body).toMatch(/9\d days/);
	});

	it("does not send a zero-results alert when the most recent meeting is within 30 days", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			mostRecentMeetingDate: "2026-04-01", // 9 days before 2026-04-10
			egovListings: [],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "fresh-body",
					name: "Fresh Body",
					egovSearchType: "12",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: true,
			now: new Date("2026-04-10T00:00:00Z"),
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.alert).toHaveLength(0);
	});

	it("processes a YouTube body by transcribing each video and storing as a meeting", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "abc123",
					title: "Town Council, March 23, 2026",
					publishedAt: "2026-03-24T00:00:00Z",
					hasCaptions: true,
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					youtubePlaylistId: "PL_test",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.youtubeList).toEqual(["PL_test"]);
		expect(log.transcribe).toEqual(["abc123"]);
		expect(log.summarize).toHaveLength(1);
		expect(log.summarize[0].sources[0].text).toContain("transcript for abc123");
		expect(log.store).toHaveLength(1);
		expect(log.drama).toBe(1);
		expect(result.processed).toBe(1);
	});

	it("stores a YouTube video under the date in its title, not its publish date", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "abc123",
					title: "Ellettsville Town Council, July 14, 2026",
					publishedAt: "2026-07-16T13:05:00Z",
					hasCaptions: true,
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Ellettsville Town Council",
					youtubePlaylistId: "PL_test",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.store.map((s) => s.date)).toEqual(["2026-07-14"]);
	});

	it("holds and alerts on a YouTube video whose title has no readable date", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "undated",
					title: "Ellettsville Town Council Special Session",
					publishedAt: "2026-07-16T13:05:00Z",
					hasCaptions: true,
				},
				{
					videoId: "dated",
					title: "Ellettsville Town Council, July 14, 2026",
					publishedAt: "2026-07-16T13:05:00Z",
					hasCaptions: true,
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Ellettsville Town Council",
					youtubePlaylistId: "PL_test",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// The undated video is never transcribed, summarized or stored; the
		// dated one behind it still goes through.
		expect(log.transcribe).toEqual(["dated"]);
		expect(log.summarize).toHaveLength(1);
		expect(log.store.map((s) => s.date)).toEqual(["2026-07-14"]);
		expect(log.held.map((h) => [h.videoId, h.reason, h.meetingDate])).toEqual([
			["undated", "unrecognized-title", null],
		]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].subject).toContain("unrecognized-title");
		expect(log.alert[0].body).toContain(
			"Title: Ellettsville Town Council Special Session",
		);
		expect(log.alert[0].body).toContain(
			"Meeting date: not readable from the title",
		);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("does not block transcript storage when drama detection fails", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "abc123",
					title: "Town Council, March 23, 2026",
					publishedAt: "2026-03-24T00:00:00Z",
					hasCaptions: true,
				},
			],
			dramaDetectionError: new Error("Gemini API down"),
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					youtubePlaylistId: "PL_test",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// Transcript and summary still landed despite drama detection failure.
		expect(log.store).toHaveLength(1);
		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
		// Operator was alerted to the drama failure.
		expect(log.alert.some((a) => a.subject.includes("drama-detection"))).toBe(
			true,
		);
	});

	it("alerts that only the one video was affected when its drama detection fails", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "abc123",
					title: "Town Council, March 23, 2026",
					publishedAt: "2026-03-24T00:00:00Z",
					hasCaptions: true,
				},
			],
			dramaDetectionError: new Error("Gemini API down"),
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					youtubePlaylistId: "PL_test",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].subject).toContain("drama-detection");
		expect(log.alert[0].body).toContain("rest of Town Council");
		expect(log.alert[0].body).not.toContain("this body was skipped");
	});

	it("persists an unreadable eGov PDF as a document row without summarizing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 42,
					title: "Scanned 2024 Minutes",
					date: "05/13/2024",
					downloadUrl: "https://example.com/doc/scanned-42",
					meetingDate: "2024-05-13",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					egovSearchType: "12",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			// Tri-state outcome: both the text-layer and OCR paths returned nothing.
			extractPdfText: async () => ({ text: "", method: "unreadable" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// Summarizer was skipped — no LLM call for an unreadable document.
		expect(log.summarize).toHaveLength(0);
		// Meeting was still persisted so the scanned minutes show up in listings.
		expect(log.store).toHaveLength(1);
		const stored = log.storeInputs[0];
		expect(stored.documents).toHaveLength(1);
		expect(stored.documents[0].extractionMethod).toBe("unreadable");
		expect(stored.documents[0].rawText).toBe("");
		expect(stored.summary).toBeUndefined();
		expect(stored.fiscalDecisions).toBeUndefined();
		// An unreadable extraction is not a pipeline error — it's a first-class
		// outcome now, so `processed` increments and `errors` stays at zero.
		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
		expect(log.alert).toHaveLength(0);
	});

	it("threads the OCR extraction method through to the stored document row", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 99,
					title: "Scanned minutes that OCR could read",
					date: "06/11/2024",
					downloadUrl: "https://example.com/doc/ocr-99",
					meetingDate: "2024-06-11",
					documentType: "minutes",
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "town-council",
					name: "Town Council",
					egovSearchType: "12",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "OCR-extracted meeting minutes discussing $42,000",
				method: "ocr",
			}),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.summarize).toHaveLength(1);
		expect(log.store).toHaveLength(1);
		expect(log.storeInputs[0].documents[0].extractionMethod).toBe("ocr");
	});

	it("summarizes readable Finalsite docs while persisting unreadable siblings on the same meeting", async () => {
		// Mixed-outcome path: a Finalsite meeting posts one image-only PDF
		// (e.g. a scanned agenda) and one machine-readable PDF (e.g. minutes).
		// The orchestrator must summarize from the readable text only, but
		// still persist both documents on the meeting so the unreadable one
		// is reachable via its source-of-record link in the UI.
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "January 20, 2026",
					meetingType: "Regular Meeting",
					year: 2026,
					documents: [
						{
							uuid: "uuid-agenda-scanned",
							documentType: "agenda",
							downloadUrl: "/fs/resource-manager/view/uuid-agenda-scanned",
							fileName: "agenda-scanned.pdf",
						},
						{
							uuid: "uuid-minutes-readable",
							documentType: "minutes",
							downloadUrl: "/fs/resource-manager/view/uuid-minutes-readable",
							fileName: "minutes-readable.pdf",
						},
					],
				},
			],
		});

		// Sequential per-call mocking via a closure counter — this is the
		// repo's idiom (see other orchestrator tests). First doc is a scanned
		// agenda that neither the text-layer nor OCR could read; second is
		// minutes with a real text layer.
		let callIndex = 0;
		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => {
				const result =
					callIndex === 0
						? ({ text: "", method: "unreadable" } as const)
						: ({
								text: "Minutes body text mentioning $10,000 facilities decision",
								method: "text-layer",
							} as const);
				callIndex += 1;
				return result;
			},
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// Summarizer ran exactly once — over the readable text only, not over
		// the unreadable doc's empty string.
		expect(log.summarize).toHaveLength(1);
		expect(log.summarize[0].sources[0].text).toContain("$10,000");

		// Single meeting persisted with both docs.
		expect(log.store).toHaveLength(1);
		const stored = log.storeInputs[0];
		expect(stored.documents).toHaveLength(2);

		const byMethod = Object.fromEntries(
			stored.documents.map((d) => [d.extractionMethod, d]),
		);
		expect(byMethod.unreadable?.rawText).toBe("");
		expect(byMethod.unreadable?.sourceUrl).toContain("uuid-agenda-scanned");
		expect(byMethod["text-layer"]?.rawText).toContain("$10,000");
		expect(byMethod["text-layer"]?.sourceUrl).toContain(
			"uuid-minutes-readable",
		);

		// Mixed meetings get the summary (only the all-unreadable case skips it).
		expect(stored.summary).toBeDefined();

		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
		expect(log.alert).toHaveLength(0);
	});

	it("persists an all-unreadable Finalsite meeting without summarizing", async () => {
		// Symmetric to the eGov all-unreadable test, but exercises the
		// distinct allUnreadable branch in processFinalsiteListing — multi-doc
		// meetings (e.g., agenda + minutes) where every document came back as
		// `unreadable` should still appear in listings via their PDF links,
		// without the summarizer being called or any error surfacing.
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "March 17, 2024",
					meetingType: "Regular Meeting",
					year: 2024,
					documents: [
						{
							uuid: "uuid-old-agenda",
							documentType: "agenda",
							downloadUrl: "/fs/resource-manager/view/uuid-old-agenda",
							fileName: "old-agenda.pdf",
						},
						{
							uuid: "uuid-old-minutes",
							documentType: "minutes",
							downloadUrl: "/fs/resource-manager/view/uuid-old-minutes",
							fileName: "old-minutes.pdf",
						},
					],
				},
			],
		});

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "", method: "unreadable" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.summarize).toHaveLength(0);
		expect(log.store).toHaveLength(1);
		const stored = log.storeInputs[0];
		expect(stored.documents).toHaveLength(2);
		expect(
			stored.documents.every((d) => d.extractionMethod === "unreadable"),
		).toBe(true);
		expect(stored.documents.every((d) => d.rawText === "")).toBe(true);
		expect(stored.summary).toBeUndefined();
		expect(stored.fiscalDecisions).toBeUndefined();
		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
		expect(log.alert).toHaveLength(0);
	});
});

/**
 * Effect teaching note: `Logger.layer([captureLogger])` installs exactly this
 * set of loggers for the scope of the provided effect (no `mergeWithExisting`,
 * so the default logger is replaced) — every `Effect.log(...)` call inside the
 * program is routed through `captureLogger` instead of the default one. The
 * capture stores the message and the annotations from `Effect.annotateLogs(...)`
 * so the test can assert on the structured stage events the orchestrator emits.
 * In v4 `Logger.make` receives `{ message, logLevel, cause, fiber, date }`; the
 * annotations are read from the fiber via `fiber.getRef(References.CurrentLogAnnotations)`.
 */
type CapturedLog = {
	message: ReadonlyArray<unknown>;
	annotations: Record<string, unknown>;
};

function buildLogCapture(): {
	captured: Array<CapturedLog>;
	layer: Layer.Layer<never>;
} {
	const captured: Array<CapturedLog> = [];
	const logger = Logger.make<unknown, void>(({ message, fiber }) => {
		captured.push({
			message: Array.isArray(message) ? message : [message],
			annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
		});
	});
	return {
		captured,
		layer: Logger.layer([logger]),
	};
}

function findStageLog(
	captured: ReadonlyArray<CapturedLog>,
	tag: string,
): CapturedLog | undefined {
	return captured.find((c) => c.message.some((m) => m === tag));
}

describe("runPipeline video path", () => {
	const TOWN_COUNCIL = {
		slug: "ellettsville-town-council",
		name: "Ellettsville Town Council",
		youtubePlaylistId: "PL_test",
		youtubeTitlePrefix: "Ellettsville Town Council",
		youtubeSince: "2025-05-27",
	};
	const REGULAR: YouTubeVideo = {
		videoId: "regular",
		title: "Ellettsville Town Council, August 25, 2025",
		publishedAt: "2025-08-27T00:00:00Z",
		hasCaptions: true,
	};
	const WORK_SESSION: YouTubeVideo = {
		videoId: "work",
		title: "Ellettsville Town Council Budget Work Session, August 25, 2025",
		publishedAt: "2025-08-27T00:00:00Z",
		hasCaptions: true,
	};
	const url = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

	function run(
		layers: ReturnType<typeof buildStubLayers>,
		youtubeDelayMs = 0,
		networkRetry = { attempts: 0, baseDelayMs: 0 },
	) {
		return runPipeline({
			bodies: [TOWN_COUNCIL],
			crawlDelayMs: 0,
			youtubeDelayMs,
			networkRetry,
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers));
	}

	it("stores a video with no existing meeting as a transcript-only meeting with a drama assessment", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({ log, youtubeVideos: [REGULAR] });

		const result = await Effect.runPromise(run(layers));

		expect(result).toEqual({ processed: 1, errors: 0 });
		expect(log.storeInputs).toHaveLength(1);
		expect(log.storeInputs[0]).toMatchObject({
			bodySlug: "ellettsville-town-council",
			date: "2025-08-25",
			session: "",
			documents: [],
		});
		expect(log.storeInputs[0].summary?.sourceKinds).toEqual(["transcript"]);
		expect(log.storeInputs[0].summary?.sourceFingerprint).toBe(
			computeSourceFingerprint([url("regular")]),
		);
		expect(log.transcripts).toEqual([
			{ meetingId: 1, sourceUrl: url("regular") },
		]);
		expect(log.drama).toBe(1);
	});

	it("sends the scorer a captions transcript with [MM:SS] markers from the segment offsets", async () => {
		// The shape the captions provider produces: rawText is the segment texts
		// joined, offsets live only in `segments`, in milliseconds.
		const segments = [
			{ text: "Call to order.", startMs: 0, durationMs: 4_000 },
			{ text: "Next is the budget item.", startMs: 4_000, durationMs: 6_000 },
			{ text: "Any discussion?", startMs: 65_000, durationMs: 5_000 },
			{ text: "No motion was made.", startMs: 125_000, durationMs: 5_000 },
		];
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			transcripts: {
				regular: {
					source: "captions",
					rawText: segments.map((s) => s.text).join(" "),
					segments,
				},
			},
		});

		await Effect.runPromise(run(layers));

		expect(log.dramaSourceTexts).toEqual([
			"[00:00] Call to order. Next is the budget item. [01:05] Any discussion? [02:05] No motion was made.",
		]);
	});

	it("stores a qualified title under the qualifier's session", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({ log, youtubeVideos: [WORK_SESSION] });

		await Effect.runPromise(run(layers));

		expect(log.storeInputs.map((i) => [i.date, i.session])).toEqual([
			["2025-08-25", "budget-work-session"],
		]);
	});

	it("holds a video titled for another body as unrecognized-title without transcribing it, counts no error, and continues", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					...REGULAR,
					videoId: "plan",
					title: "Ellettsville Plan Commission, August 25, 2025",
				},
				REGULAR,
			],
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual(["regular"]);
		expect(log.storeInputs.map((i) => i.date)).toEqual(["2025-08-25"]);
		expect(log.held).toEqual([
			{
				bodySlug: "ellettsville-town-council",
				videoId: "plan",
				title: "Ellettsville Plan Commission, August 25, 2025",
				meetingDate: "2025-08-25",
				reason: "unrecognized-title",
			},
		]);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("holds a video whose title carries only a numeric date with a null meeting date, without transcribing it", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{ ...REGULAR, title: "Ellettsville Town Council, 08-25-25" },
			],
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual([]);
		expect(log.store).toEqual([]);
		expect(log.held.map((h) => [h.reason, h.meetingDate])).toEqual([
			["unrecognized-title", null],
		]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it("ignores a video dated before youtubeSince and takes one dated on it", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					...REGULAR,
					videoId: "day-before",
					title: "Ellettsville Town Council, May 26, 2025",
				},
				{
					...REGULAR,
					videoId: "first-day",
					title: "Ellettsville Town Council, May 27, 2025",
				},
			],
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual(["first-day"]);
		expect(log.alert).toEqual([]);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("skips a video whose URL is already on a stored transcript before transcribing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR, WORK_SESSION],
			storedVideoUrls: [url("regular")],
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual(["work"]);
		expect(log.storeInputs.map((i) => i.session)).toEqual([
			"budget-work-session",
		]);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	/** A meeting stored from minutes alone, before summaries recorded their sources. */
	const minutesMeeting = (key: {
		date: string;
		session: string;
	}): MeetingSourceState | null =>
		key.session === ""
			? {
					meetingId: 7,
					date: key.date,
					session: "",
					hasDocuments: true,
					transcriptSourceUrl: null,
					summarySourceKinds: [],
				}
			: null;

	it("[QA-RELI] holds a video the check does not match and writes no transcript, summary or drama assessment to the candidate meeting", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			matchResult: {
				outcome: "hold",
				reason: "signals-disagree",
				probability: 0.8,
				sharedIdentifiers: 0,
			},
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual(["regular"]);
		expect(log.match).toHaveLength(1);
		expect(log.store).toEqual([]);
		expect(log.transcripts).toEqual([]);
		expect(log.replaced).toEqual([]);
		expect(log.stamped).toEqual([]);
		expect(log.drama).toBe(0);
		expect(log.dramaStored).toEqual([]);
		expect(log.held).toEqual([
			{
				bodySlug: "ellettsville-town-council",
				videoId: "regular",
				title: REGULAR.title,
				meetingDate: "2025-08-25",
				reason: "signals-disagree",
				probability: 0.8,
				sharedIdentifiers: 0,
				candidateMeetingId: 7,
			},
		]);
		expect(log.alert.map((a) => a.subject)).toEqual([
			expect.stringContaining("signals-disagree"),
		]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it.each([
		{
			outcome: "match" as const,
			probability: 0.93,
			sharedIdentifiers: 3,
		},
		{
			outcome: "hold" as const,
			reason: "check-failed" as const,
			probability: 0.04,
			sharedIdentifiers: 0,
		},
	])("[QA-MAINT] emits youtube.match.start and youtube.match.finish with outcome, probability and sharedIdentifiers when the check returns $outcome", async (matchResult) => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			matchResult,
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		await Effect.runPromise(run(layers).pipe(Effect.provide(loggerLayer)));

		const tags = captured.flatMap((c) => c.message);
		expect(tags.filter((t) => t === "youtube.match.start")).toHaveLength(1);
		expect(tags.filter((t) => t === "youtube.match.finish")).toHaveLength(1);
		expect(tags.indexOf("youtube.match.start")).toBeLessThan(
			tags.indexOf("youtube.match.finish"),
		);
		const start = findStageLog(captured, "youtube.match.start");
		expect(start?.annotations).toMatchObject({
			videoId: "regular",
			meetingId: 7,
		});
		const finish = findStageLog(captured, "youtube.match.finish");
		expect(finish?.annotations).toMatchObject({
			videoId: "regular",
			meetingId: 7,
			outcome: matchResult.outcome,
			probability: matchResult.probability,
			sharedIdentifiers: matchResult.sharedIdentifiers,
		});
	});

	it("checks the transcript-only summary against the meeting's stored summary", async () => {
		const log = emptyCallLog();
		const documentsSummary = {
			highlights: ["Adopted Ordinance 2025-12"],
			prose: "The council adopted Ordinance 2025-12 for $215,215.10.",
			fiscalDecisions: [{ title: "Paving bid", originalAmount: "$215,215.10" }],
		};
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			matchableSummary: documentsSummary,
		});

		await Effect.runPromise(run(layers));

		expect(log.summarize.map((call) => call.sources)).toEqual([
			[{ kind: "transcript", text: "transcript for regular" }],
		]);
		expect(log.match).toHaveLength(1);
		expect(log.match[0].documentsSummary).toEqual(documentsSummary);
		expect(log.match[0].transcriptSummary).toMatchObject({
			highlights: ["A highlight"],
			prose: "A prose summary",
		});
	});

	it("counts an error, holds nothing and writes nothing when the check itself fails", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			matchResult: new MeetingMatchError({ message: "model unavailable" }),
		});

		const result = await Effect.runPromise(run(layers));

		expect(result).toEqual({ processed: 0, errors: 1 });
		expect(log.held).toEqual([]);
		expect(log.transcripts).toEqual([]);
		expect(log.replaced).toEqual([]);
		expect(log.dramaStored).toEqual([]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("MeetingMatchError");
	});

	it("holds a video with disabled captions as no-captions when its meeting has documents, without running the check", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				}),
			},
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.match).toEqual([]);
		expect(log.held.map((h) => h.reason)).toEqual(["no-captions"]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it("leaves a video unheld and untranscribed while its meeting has documents and no summary to check against", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: minutesMeeting,
			matchableSummary: null,
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual([]);
		expect(log.match).toEqual([]);
		expect(log.held).toEqual([]);
		expect(log.transcripts).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it("writes nothing on a dry run, whether the check matches or holds", async () => {
		for (const matchResult of [
			{ outcome: "match" as const, probability: 0.9, sharedIdentifiers: 2 },
			{
				outcome: "hold" as const,
				reason: "check-failed" as const,
				probability: 0.1,
				sharedIdentifiers: 0,
			},
		]) {
			const log = emptyCallLog();
			const layers = buildStubLayers({
				log,
				youtubeVideos: [REGULAR],
				meetingSourceState: minutesMeeting,
				matchResult,
			});

			await Effect.runPromise(
				runPipeline({
					bodies: [TOWN_COUNCIL],
					crawlDelayMs: 0,
					youtubeDelayMs: 0,
					networkRetry: { attempts: 0, baseDelayMs: 0 },
					llmRetry: { attempts: 0, baseDelayMs: 0 },
					extractPdfText: async () => ({
						text: "unused",
						method: "text-layer",
					}),
					dryRun: true,
				}).pipe(Effect.provide(layers)),
			);

			expect(log.match).toHaveLength(1);
			expect(log.held).toEqual([]);
			expect(log.transcripts).toEqual([]);
			expect(log.stamped).toEqual([]);
			expect(log.replaced).toEqual([]);
			expect(log.dramaStored).toEqual([]);
			expect(log.alert).toEqual([]);
		}
	});

	it("rebuilds nothing on a dry run for a meeting whose summary lacks this video's transcript", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			meetingSourceState: (key) => ({
				meetingId: 7,
				date: key.date,
				session: key.session,
				hasDocuments: true,
				transcriptSourceUrl: url("regular"),
				summarySourceKinds: ["documents"],
			}),
			meetingSources: {
				documents: [
					{
						sourceUrl: "https://example.com/minutes.pdf",
						rawText: "minutes text",
						documentType: "minutes",
						extractionMethod: "text-layer",
					},
				],
				transcript: { sourceUrl: url("regular"), rawText: "transcript text" },
				summary: { sourceKinds: ["documents"], sourceFingerprint: "stale" },
			},
		});

		const result = await Effect.runPromise(
			runPipeline({
				bodies: [TOWN_COUNCIL],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({
					text: "unused",
					method: "text-layer",
				}),
				dryRun: true,
			}).pipe(Effect.provide(layers)),
		);

		expect(log.summarize).toEqual([]);
		expect(log.replaced).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it("holds a video as near-date before transcription when documents-only meetings lie near a title date that has no meeting", async () => {
		const nearby = (meetingId: number, date: string): MeetingSourceState => ({
			meetingId,
			date,
			session: "",
			hasDocuments: true,
			transcriptSourceUrl: null,
			summarySourceKinds: [],
		});
		const JULY_14: YouTubeVideo = {
			...REGULAR,
			videoId: "july14",
			title: "Ellettsville Town Council, July 14, 2026",
			publishedAt: "2026-07-15T00:00:00Z",
		};

		const one = emptyCallLog();
		const result = await Effect.runPromise(
			run(
				buildStubLayers({
					log: one,
					youtubeVideos: [JULY_14],
					nearbyMeetings: [nearby(7, "2026-07-13")],
				}),
			),
		);

		expect(one.transcribe).toEqual([]);
		expect(one.store).toEqual([]);
		expect(one.held).toEqual([
			{
				bodySlug: "ellettsville-town-council",
				videoId: "july14",
				title: JULY_14.title,
				meetingDate: "2026-07-14",
				reason: "near-date",
				candidateMeetingId: 7,
			},
		]);
		expect(one.alert.map((a) => a.subject)).toEqual([
			expect.stringContaining("near-date"),
		]);
		expect(result).toEqual({ processed: 0, errors: 0 });

		// Two nearby meetings name no single candidate.
		const two = emptyCallLog();
		await Effect.runPromise(
			run(
				buildStubLayers({
					log: two,
					youtubeVideos: [JULY_14],
					nearbyMeetings: [nearby(7, "2026-07-13"), nearby(8, "2026-07-16")],
				}),
			),
		);

		expect(two.transcribe).toEqual([]);
		expect(two.store).toEqual([]);
		expect(two.held.map((h) => [h.reason, h.candidateMeetingId])).toEqual([
			["near-date", undefined],
		]);
	});

	it("skips a second video for a meeting that already holds another video's transcript", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [{ ...REGULAR, videoId: "reupload" }],
			meetingSourceState: (key) => ({
				meetingId: 7,
				date: key.date,
				session: key.session,
				hasDocuments: false,
				transcriptSourceUrl: url("regular"),
				summarySourceKinds: ["transcript"],
			}),
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual([]);
		expect(log.store).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	it("skips a held video before transcription", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR, WORK_SESSION],
			heldVideoIds: ["regular"],
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.transcribe).toEqual(["work"]);
		expect(log.held).toEqual([]);
		expect(log.alert).toEqual([]);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("holds a video whose captions are disabled as no-captions, once, with its meeting date, and counts no error", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR, WORK_SESSION],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				}),
			},
		});

		const result = await Effect.runPromise(
			run(layers, 0, { attempts: 2, baseDelayMs: 0 }),
		);

		expect(log.held).toEqual([
			{
				bodySlug: "ellettsville-town-council",
				videoId: "regular",
				title: REGULAR.title,
				meetingDate: "2025-08-25",
				reason: "no-captions",
			},
		]);
		// A disabled video is asked for once: retrying cannot change the answer.
		expect(log.transcribe).toEqual(["regular", "work"]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].subject).toContain("no-captions");
		expect(log.storeInputs.map((i) => i.session)).toEqual([
			"budget-work-session",
		]);
		expect(result).toEqual({ processed: 1, errors: 0 });
	});

	it("leaves a recently published video with disabled captions unheld and counts an error, so a later run retries it", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [{ ...REGULAR, publishedAt: "2025-08-27T00:00:00Z" }],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				}),
			},
		});

		const result = await Effect.runPromise(
			runPipeline({
				bodies: [TOWN_COUNCIL],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
				dryRun: false,
				now: new Date("2025-08-28T00:00:00Z"),
			}).pipe(Effect.provide(layers)),
		);

		expect(log.held).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 1 });
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain(REGULAR.title);
		expect(log.alert[0].body).toContain("retried on a later run");
		expect(log.alert[0].body).not.toContain("Captions are disabled");
	});

	describe("the captions grace period boundary", () => {
		// Published 2025-08-27T00:00:00Z. Exactly seven days later is
		// 2025-09-03T00:00:00Z. The dates are literal on purpose.
		async function runAt(now: Date) {
			const log = emptyCallLog();
			const layers = buildStubLayers({
				log,
				youtubeVideos: [REGULAR],
				transcriptionErrors: {
					regular: new TranscriptionError({
						videoId: "regular",
						message: "Captions are disabled for this video",
						captionsDisabled: true,
					}),
				},
			});
			const result = await Effect.runPromise(
				runPipeline({
					bodies: [TOWN_COUNCIL],
					crawlDelayMs: 0,
					youtubeDelayMs: 0,
					networkRetry: { attempts: 0, baseDelayMs: 0 },
					llmRetry: { attempts: 0, baseDelayMs: 0 },
					extractPdfText: async () => ({
						text: "unused",
						method: "text-layer",
					}),
					dryRun: false,
					now,
				}).pipe(Effect.provide(layers)),
			);
			return { log, result };
		}

		it("does not hold a video one millisecond short of seven days after it was published", async () => {
			const { log, result } = await runAt(new Date("2025-09-02T23:59:59.999Z"));

			expect(log.held).toEqual([]);
			expect(result).toEqual({ processed: 0, errors: 1 });
		});

		it("holds a video exactly seven days after it was published", async () => {
			const { log, result } = await runAt(new Date("2025-09-03T00:00:00Z"));

			expect(log.held).toEqual([
				{
					bodySlug: "ellettsville-town-council",
					videoId: "regular",
					title: REGULAR.title,
					meetingDate: "2025-08-25",
					reason: "no-captions",
				},
			]);
			expect(result).toEqual({ processed: 0, errors: 0 });
		});
	});

	it("leaves a video with an unreadable publish date unheld and counts an error, however disabled its captions", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [{ ...REGULAR, publishedAt: "" }],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				}),
			},
		});

		const result = await Effect.runPromise(
			run(layers, 0, { attempts: 0, baseDelayMs: 0 }),
		);

		expect(log.held).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 1 });
	});

	it("counts an error and leaves the video unheld when the caption fetch fails for any other reason", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message:
						"No caption tracks reported (captions disabled not confirmed)",
				}),
			},
		});

		const result = await Effect.runPromise(run(layers));

		expect(log.held).toEqual([]);
		expect(log.store).toEqual([]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].subject).toContain("transcribe failed");
		expect(result).toEqual({ processed: 0, errors: 1 });
	});

	it("retries an ordinary caption failure up to the retry budget before counting an error", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [REGULAR],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Transient YouTube failure",
				}),
			},
		});

		const result = await Effect.runPromise(
			run(layers, 0, { attempts: 2, baseDelayMs: 0 }),
		);

		// One call plus two retries: only disabled captions skip the retries.
		expect(log.transcribe).toEqual(["regular", "regular", "regular"]);
		expect(log.held).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 1 });
	});

	it("records no hold and sends no alert on a dry run", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{ ...REGULAR, videoId: "plan", title: "Plan Commission, May 1, 2026" },
				REGULAR,
			],
			transcriptionErrors: {
				regular: new TranscriptionError({
					videoId: "regular",
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				}),
			},
		});

		const result = await Effect.runPromise(
			runPipeline({
				bodies: [TOWN_COUNCIL],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "unused", method: "text-layer" }),
				dryRun: true,
			}).pipe(Effect.provide(layers)),
		);

		expect(log.held).toEqual([]);
		expect(log.alert).toEqual([]);
		expect(result).toEqual({ processed: 0, errors: 0 });
	});

	describe("holdVideoAndAlert", () => {
		const hold = { reason: "no-captions" as const, meetingDate: "2025-08-25" };

		it("sends exactly one alert naming the title, reason and meeting date when a video is held for the first time", async () => {
			const log = emptyCallLog();

			await Effect.runPromise(
				holdVideoAndAlert(TOWN_COUNCIL, REGULAR, hold, { dryRun: false }).pipe(
					Effect.provide(buildStubLayers({ log })),
				),
			);

			expect(log.held.map((h) => h.videoId)).toEqual(["regular"]);
			expect(log.alert).toHaveLength(1);
			expect(log.alert[0].body).toContain(`Title: ${REGULAR.title}`);
			expect(log.alert[0].body).toContain("Reason: no-captions");
			expect(log.alert[0].body).toContain("Meeting date: 2025-08-25");
		});

		it("sends no alert when the video is already held", async () => {
			const log = emptyCallLog();

			await Effect.runPromise(
				holdVideoAndAlert(TOWN_COUNCIL, REGULAR, hold, { dryRun: false }).pipe(
					Effect.provide(buildStubLayers({ log, heldVideoIds: ["regular"] })),
				),
			);

			expect(log.alert).toEqual([]);
		});

		it("records no hold and sends no alert on a dry run", async () => {
			const log = emptyCallLog();

			await Effect.runPromise(
				holdVideoAndAlert(TOWN_COUNCIL, REGULAR, hold, { dryRun: true }).pipe(
					Effect.provide(buildStubLayers({ log })),
				),
			);

			expect(log.held).toEqual([]);
			expect(log.alert).toEqual([]);
		});
	});

	it("paces only the videos it transcribes", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					...REGULAR,
					videoId: "old",
					title: "Ellettsville Town Council, January 13, 2025",
				},
				{ ...REGULAR, videoId: "stored" },
				WORK_SESSION,
			],
			storedVideoUrls: [url("stored")],
		});
		const { sleeps, effect } = withRecordedSleeps(run(layers, 2000));

		await Effect.runPromise(effect);

		expect(log.transcribe).toEqual(["work"]);
		expect(sleeps).toEqual([2000]);
	});

	describe("source selection", () => {
		const BOTH = { ...TOWN_COUNCIL, egovSearchType: "12" };
		const egovListing: EgovDocumentListing = {
			id: 1,
			title: "Town Council Meeting Minutes August 11, 2025",
			date: "08/12/2025",
			downloadUrl: "https://example.com/doc/1",
			meetingDate: "2025-08-11",
			documentType: "minutes",
		};

		function runSources(
			log: CallLog,
			sources?: Array<"egov" | "finalsite" | "youtube">,
		) {
			return runPipeline({
				bodies: [BOTH],
				crawlDelayMs: 0,
				youtubeDelayMs: 0,
				networkRetry: { attempts: 0, baseDelayMs: 0 },
				llmRetry: { attempts: 0, baseDelayMs: 0 },
				extractPdfText: async () => ({ text: "minutes", method: "text-layer" }),
				dryRun: false,
				...(sources ? { sources } : {}),
			}).pipe(
				Effect.provide(
					buildStubLayers({
						log,
						egovListings: [egovListing],
						youtubeVideos: [REGULAR],
					}),
				),
			);
		}

		it("runs only the video path when sources is youtube", async () => {
			const log = emptyCallLog();

			const result = await Effect.runPromise(runSources(log, ["youtube"]));

			expect(log.egovScrape).toBe(0);
			expect(log.egovDownload).toEqual([]);
			expect(log.transcribe).toEqual(["regular"]);
			expect(result).toEqual({ processed: 1, errors: 0 });
		});

		it("leaves the video path out when sources is egov", async () => {
			const log = emptyCallLog();

			await Effect.runPromise(runSources(log, ["egov"]));

			expect(log.egovScrape).toBe(1);
			expect(log.youtubeList).toEqual([]);
			expect(log.transcribe).toEqual([]);
		});

		it("runs every path the body has when sources is omitted", async () => {
			const log = emptyCallLog();

			const result = await Effect.runPromise(runSources(log));

			expect(log.egovScrape).toBe(1);
			expect(log.youtubeList).toEqual(["PL_test"]);
			expect(result).toEqual({ processed: 2, errors: 0 });
		});
	});

	describe("against a real database", () => {
		async function setup() {
			const db = await createMigratedTestDb();
			await db
				.insert(schema.governingBodies)
				.values({
					name: TOWN_COUNCIL.name,
					slug: TOWN_COUNCIL.slug,
					type: "town",
				})
				.run();
			const counts = async () => ({
				meetings: (await db.select().from(schema.meetings).all()).length,
				summaries: (await db.select().from(schema.summaries).all()).length,
				transcripts: (await db.select().from(schema.transcripts).all()).length,
				drama: (await db.select().from(schema.dramaAssessments).all()).length,
				held: (await db.select().from(schema.heldVideos).all()).length,
			});
			return { db, counts };
		}

		it("stores the regular and work-session videos of one date as two meetings", async () => {
			const { db } = await setup();
			const log = emptyCallLog();
			const layers = buildStubLayers({
				log,
				youtubeVideos: [REGULAR, WORK_SESSION],
				storage: StorageServiceLive(db),
			});

			const result = await Effect.runPromise(run(layers));

			expect(result).toEqual({ processed: 2, errors: 0 });
			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings.map((m) => [m.date, m.session]).sort()).toEqual([
				["2025-08-25", ""],
				["2025-08-25", "budget-work-session"],
			]);
			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts.map((t) => [t.meetingId, t.sourceUrl]).sort()).toEqual(
				[
					[meetings.find((m) => m.session === "")?.id, url("regular")],
					[meetings.find((m) => m.session !== "")?.id, url("work")],
				].sort(),
			);
			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries.map((s) => s.sourceKinds)).toEqual([
				["transcript"],
				["transcript"],
			]);
			expect(
				await db.select().from(schema.dramaAssessments).all(),
			).toHaveLength(2);
		});

		it("makes zero transcribe and zero summarize calls on a second run over the same playlist", async () => {
			const { db, counts } = await setup();
			const videos = [REGULAR, WORK_SESSION];

			const first = emptyCallLog();
			await Effect.runPromise(
				run(
					buildStubLayers({
						log: first,
						youtubeVideos: videos,
						storage: StorageServiceLive(db),
					}),
				),
			);
			expect(first.transcribe).toEqual(["regular", "work"]);
			const afterFirst = await counts();

			const second = emptyCallLog();
			const result = await Effect.runPromise(
				run(
					buildStubLayers({
						log: second,
						youtubeVideos: videos,
						storage: StorageServiceLive(db),
					}),
				),
			);

			expect(second.youtubeList).toEqual(["PL_test"]);
			expect(second.transcribe).toEqual([]);
			expect(second.summarize).toEqual([]);
			expect(second.drama).toBe(0);
			expect(result).toEqual({ processed: 0, errors: 0 });
			expect(await counts()).toEqual(afterFirst);
		});

		it("[QA-RELI] leaves held_videos unchanged and sends no second alert on a second run over a playlist with held videos", async () => {
			const { db, counts } = await setup();
			const videos = [
				{
					...REGULAR,
					videoId: "plan",
					title: "Ellettsville Plan Commission, August 25, 2025",
				},
				REGULAR,
				WORK_SESSION,
			];
			const runOnce = async () => {
				const log = emptyCallLog();
				const result = await Effect.runPromise(
					run(
						buildStubLayers({
							log,
							youtubeVideos: videos,
							storage: StorageServiceLive(db),
							transcriptionErrors: {
								regular: new TranscriptionError({
									videoId: "regular",
									message: "Captions are disabled for this video",
									captionsDisabled: true,
								}),
							},
						}),
					),
				);
				return { log, result };
			};

			// The run also raises its no-new-content alert, which is not about
			// any one video.
			const holdAlerts = (log: CallLog) =>
				log.alert.map((a) => a.subject).filter((s) => s.includes("held"));

			const first = await runOnce();
			expect(holdAlerts(first.log)).toEqual([
				expect.stringContaining("unrecognized-title"),
				expect.stringContaining("no-captions"),
			]);
			const afterFirst = await counts();
			expect(afterFirst.held).toBe(2);

			const second = await runOnce();

			expect(second.log.transcribe).toEqual([]);
			expect(holdAlerts(second.log)).toEqual([]);
			expect(second.result).toEqual({ processed: 0, errors: 0 });
			expect(await counts()).toEqual(afterFirst);
		});

		const MINUTES_URL = "https://example.com/minutes.pdf";

		/** A meeting stored from minutes alone, as the eGov path left them before summaries recorded sources. */
		async function seedMinutesMeeting(
			db: Awaited<ReturnType<typeof createMigratedTestDb>>,
			date: string,
			sourceUrl = MINUTES_URL,
		) {
			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting({
						bodySlug: TOWN_COUNCIL.slug,
						date,
						meetingType: "regular",
						documents: [
							{
								sourceUrl,
								rawText: "Minutes of the meeting.",
								documentType: "minutes",
								extractionMethod: "text-layer",
							},
						],
						summary: { highlights: ["h"], prose: "p", model: "m" },
					});
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
			return meeting.id;
		}

		function runAgainst(
			db: Awaited<ReturnType<typeof createMigratedTestDb>>,
			config: Omit<StubConfig, "log" | "storage">,
		) {
			const log = emptyCallLog();
			return Effect.runPromise(
				run(
					buildStubLayers({
						youtubeVideos: [REGULAR],
						...config,
						log,
						storage: StorageServiceLive(db),
					}),
				),
			).then((result) => ({ log, result }));
		}

		it("attaches a matched video to the meeting that has its minutes: transcript stored, summary rebuilt from both sources, drama assessed", async () => {
			const { db, counts } = await setup();
			const meetingId = await seedMinutesMeeting(db, "2025-08-25");

			const { log, result } = await runAgainst(db, {
				summarizationResult: {
					highlights: ["Combined highlight"],
					prose: "Combined prose",
					fiscalDecisions: [],
					budgetDiscussions: [],
					sourceDisagreements: [],
					model: "stub-model",
				},
			});

			expect(result).toEqual({ processed: 1, errors: 0 });
			expect(log.match[0].documentsSummary).toEqual({
				highlights: ["h"],
				prose: "p",
				fiscalDecisions: [],
			});
			// Once for the check, once for the summary that is stored.
			expect(log.summarize.map((c) => c.sources.map((s) => s.kind))).toEqual([
				["transcript"],
				["documents", "transcript"],
			]);
			expect(await counts()).toEqual({
				meetings: 1,
				summaries: 1,
				transcripts: 1,
				drama: 1,
				held: 0,
			});
			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts.map((t) => [t.meetingId, t.sourceUrl])).toEqual([
				[meetingId, url("regular")],
			]);
			const [summary] = await db.select().from(schema.summaries).all();
			expect(summary.meetingId).toBe(meetingId);
			expect(summary.prose).toBe("Combined prose");
			expect(summary.sourceKinds).toEqual(["documents", "transcript"]);
			expect(summary.sourceFingerprint).toBe(
				computeSourceFingerprint([MINUTES_URL, url("regular")]),
			);
			const [drama] = await db.select().from(schema.dramaAssessments).all();
			expect(drama.meetingId).toBe(meetingId);
		});

		it("holds an unmatched video and leaves the meeting that has minutes exactly as it was", async () => {
			const { db, counts } = await setup();
			const meetingId = await seedMinutesMeeting(db, "2025-08-25");
			const before = await counts();
			const summaryBefore = await db.select().from(schema.summaries).all();

			const { result } = await runAgainst(db, {
				matchResult: {
					outcome: "hold",
					reason: "check-failed",
					probability: 0.02,
					sharedIdentifiers: 0,
				},
			});

			expect(result).toEqual({ processed: 0, errors: 0 });
			expect(await counts()).toEqual({ ...before, held: 1 });
			expect(await db.select().from(schema.summaries).all()).toEqual(
				summaryBefore,
			);
			const [held] = await db.select().from(schema.heldVideos).all();
			expect(held).toMatchObject({
				videoId: "regular",
				meetingDate: "2025-08-25",
				reason: "check-failed",
				probability: 0.02,
				sharedIdentifiers: 0,
				candidateMeetingId: meetingId,
			});
		});

		it.each([
			{ name: "matched", matchResult: undefined },
			{
				name: "was held",
				matchResult: {
					outcome: "hold" as const,
					reason: "signals-disagree" as const,
					probability: 0.7,
					sharedIdentifiers: 0,
				},
			},
		])("[QA-RELI] makes no transcribe, summarize or match call on a second run for a video that $name on the first", async ({
			matchResult,
		}) => {
			const { db, counts } = await setup();
			await seedMinutesMeeting(db, "2025-08-25");

			const first = await runAgainst(db, { matchResult });
			expect(first.log.match).toHaveLength(1);
			const afterFirst = await counts();

			const second = await runAgainst(db, { matchResult });

			expect(second.log.transcribe).toEqual([]);
			expect(second.log.summarize).toEqual([]);
			expect(second.log.match).toEqual([]);
			expect(second.log.drama).toBe(0);
			// A run that brings nothing new raises its no-new-content alert,
			// which is not about any one video.
			expect(
				second.log.alert.filter((a) => a.subject.includes("held")),
			).toEqual([]);
			expect(second.result).toEqual({ processed: 0, errors: 0 });
			expect(await counts()).toEqual(afterFirst);
		});

		it("holds nothing when the check fails, and checks the video again on the next run", async () => {
			const { db, counts } = await setup();
			await seedMinutesMeeting(db, "2025-08-25");
			const before = await counts();

			const first = await runAgainst(db, {
				matchResult: new MeetingMatchError({ message: "model unavailable" }),
			});

			expect(first.result).toEqual({ processed: 0, errors: 1 });
			expect(await counts()).toEqual(before);

			const second = await runAgainst(db, {});

			expect(second.log.transcribe).toEqual(["regular"]);
			expect(second.log.match).toHaveLength(1);
			expect(second.result).toEqual({ processed: 1, errors: 0 });
			expect(await counts()).toEqual({ ...before, transcripts: 1, drama: 1 });
		});

		it("keeps the transcript and drama assessment when regeneration fails after a match, and rebuilds the summary on the next run without transcribing or checking again", async () => {
			const { db, counts } = await setup();
			await seedMinutesMeeting(db, "2025-08-25");

			const first = await runAgainst(db, {
				summarizationFailsWhen: (input) => input.sources.length > 1,
			});

			expect(first.result).toEqual({ processed: 0, errors: 1 });
			expect(await counts()).toEqual({
				meetings: 1,
				summaries: 1,
				transcripts: 1,
				drama: 1,
				held: 0,
			});
			const [stale] = await db.select().from(schema.summaries).all();
			expect(stale.prose).toBe("p");

			const second = await runAgainst(db, {});

			expect(second.log.transcribe).toEqual([]);
			expect(second.log.match).toEqual([]);
			expect(second.log.drama).toBe(0);
			expect(
				second.log.summarize.map((c) => c.sources.map((s) => s.kind)),
			).toEqual([["documents", "transcript"]]);
			const [rebuilt] = await db.select().from(schema.summaries).all();
			expect(rebuilt.sourceKinds).toEqual(["documents", "transcript"]);

			const third = await runAgainst(db, {});
			expect(third.log.summarize).toEqual([]);
		});

		it("still reads a summary stored without kinds as built from the official documents when regeneration fails after a video is attached", async () => {
			const { db } = await setup();
			await seedMinutesMeeting(db, "2025-08-25");

			const { result } = await runAgainst(db, {
				summarizationFailsWhen: (input) => input.sources.length > 1,
			});

			expect(result).toEqual({ processed: 0, errors: 1 });
			expect(await db.select().from(schema.transcripts).all()).toHaveLength(1);
			const [stale] = await db.select().from(schema.summaries).all();
			expect(stale.prose).toBe("p");
			expect(stale.sourceKinds).toEqual(["documents"]);
			const page = await getMeetingByBodyAndDateQuery(
				db,
				TOWN_COUNCIL.slug,
				"2025-08-25",
			);
			expect(page?.summarySources).toEqual({ origin: "documents" });
		});

		it("stamps a summary stored without kinds as built from the documents alone when a video is attached to a meeting that already holds a transcript with no URL", async () => {
			const { db } = await setup();
			const meetingId = await seedMinutesMeeting(db, "2025-08-25");
			// A transcript with no URL does not stop a video being matched to
			// the meeting, so the stamp is written with a transcript held.
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeTranscript({
						meetingId,
						source: "whisper",
						rawText: "transcript text",
					});
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			// The stamp is what is read back, so no rebuild may replace it.
			const { log } = await runAgainst(db, {
				summarizationFailsWhen: (input) => input.sources.length > 1,
			});

			expect(log.match).toHaveLength(1);
			expect(await db.select().from(schema.transcripts).all()).toHaveLength(2);
			const [stamped] = await db.select().from(schema.summaries).all();
			expect(stamped.prose).toBe("p");
			expect(stamped.sourceKinds).toEqual(["documents"]);
			expect(stamped.sourceFingerprint).toBe(
				computeSourceFingerprint([MINUTES_URL]),
			);
		});

		it("holds a video titled July 14, 2026 as near-date when the town's document is dated July 13, and creates no second meeting", async () => {
			const { db, counts } = await setup();
			const meetingId = await seedMinutesMeeting(db, "2026-07-13");
			const before = await counts();

			const { log, result } = await runAgainst(db, {
				youtubeVideos: [
					{
						...REGULAR,
						videoId: "july14",
						title: "Ellettsville Town Council, July 14, 2026",
						publishedAt: "2026-07-15T00:00:00Z",
					},
				],
			});

			expect(log.transcribe).toEqual([]);
			expect(result).toEqual({ processed: 0, errors: 0 });
			expect(await counts()).toEqual({ ...before, held: 1 });
			const [held] = await db.select().from(schema.heldVideos).all();
			expect(held).toMatchObject({
				videoId: "july14",
				meetingDate: "2026-07-14",
				reason: "near-date",
				candidateMeetingId: meetingId,
			});
		});

		it("checks a video against the meeting on its own title date and holds nothing as near-date when minutes also exist the day before", async () => {
			const { db, counts } = await setup();
			const meetingId = await seedMinutesMeeting(db, "2025-08-25");
			await seedMinutesMeeting(
				db,
				"2025-08-24",
				"https://example.com/minutes-day-before.pdf",
			);

			const { log, result } = await runAgainst(db, {});

			expect(result).toEqual({ processed: 1, errors: 0 });
			expect(log.match).toHaveLength(1);
			expect(await counts()).toMatchObject({ meetings: 2, held: 0 });
			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts.map((t) => t.meetingId)).toEqual([meetingId]);
		});

		it("stores a video as its own video-only meeting when the nearest documents-only meeting is three days from its title date", async () => {
			const { db, counts } = await setup();
			await seedMinutesMeeting(db, "2025-08-22");

			const { log, result } = await runAgainst(db, {});

			expect(log.transcribe).toEqual(["regular"]);
			expect(log.match).toEqual([]);
			expect(result).toEqual({ processed: 1, errors: 0 });
			expect(await counts()).toEqual({
				meetings: 2,
				summaries: 2,
				transcripts: 1,
				drama: 1,
				held: 0,
			});
		});
	});
});

describe("runPipeline stage logging", () => {
	it("emits a download.start stage log with body and url annotations during egov processing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1,
					title: "Town Council Meeting Minutes February 4, 2026",
					date: "02/04/2026",
					downloadUrl: "https://example.com/doc/1",
					meetingDate: "2026-02-04",
					documentType: "minutes",
				},
			],
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		const program = runPipeline({
			bodies: [
				{ slug: "town-council", name: "Town Council", egovSearchType: "12" },
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "body text",
				method: "text-layer",
			}),
			dryRun: true,
		}).pipe(Effect.provide(layers), Effect.provide(loggerLayer));

		await Effect.runPromise(program);

		const downloadStart = findStageLog(captured, "egov.download.start");
		expect(downloadStart).toBeDefined();
		expect(downloadStart?.annotations.body).toBe("town-council");
		expect(downloadStart?.annotations.url).toBe("https://example.com/doc/1");
	});

	it("emits ordered download/extract/summarize stage logs for a readable egov listing", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			egovListings: [
				{
					id: 1,
					title: "Town Council Meeting Minutes February 4, 2026",
					date: "02/04/2026",
					downloadUrl: "https://example.com/doc/1",
					meetingDate: "2026-02-04",
					documentType: "minutes",
				},
			],
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		const program = runPipeline({
			bodies: [
				{ slug: "town-council", name: "Town Council", egovSearchType: "12" },
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "body text",
				method: "ocr",
			}),
			dryRun: true,
		}).pipe(Effect.provide(layers), Effect.provide(loggerLayer));

		await Effect.runPromise(program);

		const tags = captured
			.flatMap((c) =>
				c.message.filter((m): m is string => typeof m === "string"),
			)
			.filter((m) => m.startsWith("egov."));

		expect(tags).toEqual([
			"egov.download.start",
			"egov.download.finish",
			"egov.extract.start",
			"egov.extract.finish",
			"egov.summarize.start",
			"egov.summarize.finish",
		]);

		const downloadFinish = findStageLog(captured, "egov.download.finish");
		expect(downloadFinish?.annotations.bytes).toBe("fake pdf".length);

		const extractFinish = findStageLog(captured, "egov.extract.finish");
		expect(extractFinish?.annotations.method).toBe("ocr");
	});

	it("emits per-document finalsite download/extract logs and a single summarize pair", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "January 20, 2026",
					meetingType: "Regular Meeting",
					year: 2026,
					documents: [
						{
							uuid: "uuid-agenda",
							documentType: "agenda",
							downloadUrl: "/fs/resource-manager/view/uuid-agenda",
							fileName: "agenda.pdf",
						},
						{
							uuid: "uuid-minutes",
							documentType: "minutes",
							downloadUrl: "/fs/resource-manager/view/uuid-minutes",
							fileName: "minutes.pdf",
						},
					],
				},
			],
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({
				text: "school board text",
				method: "text-layer",
			}),
			dryRun: true,
		}).pipe(Effect.provide(layers), Effect.provide(loggerLayer));

		await Effect.runPromise(program);

		const tags = captured
			.flatMap((c) =>
				c.message.filter((m): m is string => typeof m === "string"),
			)
			.filter((m) => m.startsWith("finalsite."));

		expect(tags).toEqual([
			"finalsite.download.start",
			"finalsite.download.finish",
			"finalsite.extract.start",
			"finalsite.extract.finish",
			"finalsite.download.start",
			"finalsite.download.finish",
			"finalsite.extract.start",
			"finalsite.extract.finish",
			"finalsite.summarize.start",
			"finalsite.summarize.finish",
		]);

		const downloadStarts = captured.filter((c) =>
			c.message.includes("finalsite.download.start"),
		);
		expect(downloadStarts).toHaveLength(2);
		expect(downloadStarts[0]?.annotations.uuid).toBe("uuid-agenda");
		expect(downloadStarts[1]?.annotations.uuid).toBe("uuid-minutes");
		expect(downloadStarts[0]?.annotations.body).toBe("school-board");
	});

	it("emits transcribe/summarize/drama stage logs for a youtube video", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			youtubeVideos: [
				{
					videoId: "vid-001",
					title: "School Board, April 15, 2026",
					publishedAt: "2026-04-15T00:00:00Z",
					hasCaptions: true,
				},
			],
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					youtubePlaylistId: "PL-XYZ",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "", method: "unreadable" }),
			dryRun: false,
		}).pipe(Effect.provide(layers), Effect.provide(loggerLayer));

		await Effect.runPromise(program);

		const tags = captured
			.flatMap((c) =>
				c.message.filter((m): m is string => typeof m === "string"),
			)
			.filter((m) => m.startsWith("youtube."));

		expect(tags).toEqual([
			"youtube.transcribe.start",
			"youtube.transcribe.finish",
			"youtube.summarize.start",
			"youtube.summarize.finish",
			"youtube.drama.start",
			"youtube.drama.finish",
		]);

		const transcribeStart = findStageLog(captured, "youtube.transcribe.start");
		expect(transcribeStart?.annotations.body).toBe("school-board");
		expect(transcribeStart?.annotations.videoId).toBe("vid-001");
	});

	it("logs a skipped month-only Finalsite listing with its date cell and meeting type", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({
			log,
			finalsiteListings: [
				{
					date: "September 2025",
					meetingType: "Superintendent's Contract",
					year: 2025,
					documents: [
						{
							uuid: "uuid-month-only",
							documentType: "notice",
							downloadUrl: "/fs/resource-manager/view/uuid-month-only",
							fileName: "uuid-month-only.pdf",
						},
					],
				},
			],
		});
		const { captured, layer: loggerLayer } = buildLogCapture();

		const program = runPipeline({
			bodies: [
				{
					slug: "school-board",
					name: "School Board",
					finalsiteUrl: "https://example.com/school-board",
				},
			],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => ({ text: "text", method: "text-layer" }),
			dryRun: false,
		}).pipe(Effect.provide(layers), Effect.provide(loggerLayer));

		await Effect.runPromise(program);

		const skipped = findStageLog(captured, "finalsite.listing.skipped");
		expect(skipped?.annotations).toMatchObject({
			body: "school-board",
			reason: "month-only date",
			date: "September 2025",
			meetingType: "Superintendent's Contract",
		});
	});
});

describe("runDramaDetectForVideo", () => {
	it("runs the YouTube path on one video without scraping a playlist", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({ log });

		const program = runDramaDetectForVideo({
			body: { slug: "town-council", name: "Town Council" },
			video: {
				videoId: "rbb-hiring-2026-04-15",
				title: "RBB School Board, April 15 2026",
			},
			meetingDate: "2026-04-15",
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		// Did NOT touch the playlist scraper.
		expect(log.youtubeList).toHaveLength(0);
		// Did transcribe, summarize, store, and run drama detection.
		expect(log.transcribe).toEqual(["rbb-hiring-2026-04-15"]);
		expect(log.summarize).toHaveLength(1);
		expect(log.store).toHaveLength(1);
		expect(log.drama).toBe(1);
		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
	});

	it("files the video under the meeting date the operator gave", async () => {
		const log = emptyCallLog();
		const layers = buildStubLayers({ log });

		const program = runDramaDetectForVideo({
			body: { slug: "town-council", name: "Town Council" },
			video: { videoId: "abc123", title: "Manual drama:detect abc123" },
			meetingDate: "2026-04-15",
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.store.map((s) => s.date)).toEqual(["2026-04-15"]);
	});

	it.each([
		["drama detection", { dramaDetectionError: new Error("Gemini API down") }],
		["summarization", { summarizationError: new Error("Gemini API down") }],
	])("does not promise to continue with the body when %s fails for the one video", async (_stage, failure) => {
		const log = emptyCallLog();
		const layers = buildStubLayers({ log, ...failure });

		const program = runDramaDetectForVideo({
			body: { slug: "town-council", name: "Town Council" },
			video: {
				videoId: "rbb-hiring-2026-04-15",
				title: "RBB School Board, April 15 2026",
			},
			meetingDate: "2026-04-15",
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
		}).pipe(Effect.provide(layers));

		await Effect.runPromise(program);

		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("Gemini API down");
		expect(log.alert[0].body).not.toContain("rest of Town Council");
		expect(log.alert[0].body).toContain("only item in this run");
	});
});

describe("runPipeline document regeneration", () => {
	const COUNCIL = {
		slug: "town-council",
		name: "Town Council",
		egovSearchType: "12",
	};
	const BOARD = {
		slug: "school-board",
		name: "School Board",
		finalsiteUrl: "https://example.com/school-board",
	};

	const egovListing = (
		id: number,
		documentType: "agenda" | "minutes",
	): EgovDocumentListing => ({
		id,
		title: `Town Council Meeting May 27, 2025 ${documentType}`,
		date: "06/01/2025",
		downloadUrl: `https://example.com/doc/${id}`,
		meetingDate: "2025-05-27",
		documentType,
	});
	const AGENDA = egovListing(1, "agenda");
	const MINUTES = egovListing(2, "minutes");

	const REGENERATED: SummarizationResult = {
		highlights: ["Regenerated highlight"],
		prose: "Regenerated prose",
		fiscalDecisions: [
			{
				title: "Regenerated decision",
				description: "From both documents",
				amount: 100,
				originalAmount: "$100",
				status: "approved",
				confidence: 0.9,
				isRecurring: false,
			},
		],
		budgetDiscussions: [{ topic: "Regenerated discussion" }],
		sourceDisagreements: [],
		model: "stub-model",
	};

	async function setup() {
		const db = await createMigratedTestDb();
		await db
			.insert(schema.governingBodies)
			.values([
				{ name: COUNCIL.name, slug: COUNCIL.slug, type: "town" },
				{ name: BOARD.name, slug: BOARD.slug, type: "school" },
			])
			.run();
		const rows = async () => ({
			documents: await db.select().from(schema.documents).all(),
			summaries: await db.select().from(schema.summaries).all(),
			fiscalDecisions: await db.select().from(schema.fiscalDecisions).all(),
			budgetDiscussions: await db.select().from(schema.budgetDiscussions).all(),
		});
		/** One pipeline run over the given listings, against the database. */
		const run = async (
			{
				crawlDelayMs = 0,
				extractedText,
				...config
			}: Omit<StubConfig, "log"> & {
				crawlDelayMs?: number;
				/** Replaces the numbered stub text for every document in the run. */
				extractedText?: string;
			},
			body: Parameters<typeof runPipeline>[0]["bodies"][number] = COUNCIL,
			unreadable = false,
		) => {
			const log = emptyCallLog();
			const { captured, layer: loggerLayer } = buildLogCapture();
			const { sleeps, effect } = withRecordedSleeps(
				runPipeline({
					bodies: [body],
					crawlDelayMs,
					networkRetry: { attempts: 0, baseDelayMs: 0 },
					llmRetry: { attempts: 0, baseDelayMs: 0 },
					// Each download is the same stub bytes, so the text is numbered
					// per run to tell one document's from the next.
					extractPdfText: async () =>
						unreadable
							? { text: "", method: "unreadable" }
							: {
									text:
										extractedText ??
										`document text ${log.egovDownload.length + log.finalsiteDownload.length}`,
									method: "text-layer",
								},
					dryRun: false,
					// Inside the zero-results window of the meetings stored here.
					now: new Date("2025-06-01"),
				}).pipe(
					Effect.provide(
						buildStubLayers({
							...config,
							log,
							storage: config.storage ?? StorageServiceLive(db),
						}),
					),
					Effect.provide(loggerLayer),
				),
			);
			const result = await Effect.runPromise(effect);
			return { log, result, captured, sleeps };
		};
		return { db, rows, run };
	}

	it("attaches a second eGov document to a meeting with a documents-only summary and replaces the summary with one built from both", async () => {
		const { rows, run } = await setup();
		await run({
			egovListings: [AGENDA],
			summarizationResult: {
				...REGENERATED,
				highlights: ["Agenda-only highlight"],
				fiscalDecisions: [
					{ ...REGENERATED.fiscalDecisions[0], title: "Agenda-only decision" },
				],
				budgetDiscussions: [{ topic: "Agenda-only discussion" }],
			},
		});
		expect((await rows()).summaries[0].highlights).toEqual([
			"Agenda-only highlight",
		]);

		const { log, result } = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationResult: REGENERATED,
		});

		expect(result.errors).toBe(0);
		expect(log.alert).toEqual([]);
		expect(log.summarize).toHaveLength(1);
		expect(log.summarize[0].sources.map((s) => s.kind)).toEqual([
			"documents",
			"documents",
		]);
		expect(log.summarize[0].meetingContext).toBe("Town Council, 2025-05-27");

		const after = await rows();
		expect(after.documents.map((d) => d.sourceUrl)).toEqual([
			AGENDA.downloadUrl,
			MINUTES.downloadUrl,
		]);
		expect(log.summarize[0].sources.map((s) => s.text)).toEqual(
			after.documents.map((d) => d.rawText),
		);
		expect(after.summaries).toHaveLength(1);
		expect(after.summaries[0]).toMatchObject({
			highlights: ["Regenerated highlight"],
			sourceKinds: ["documents"],
			sourceFingerprint: computeSourceFingerprint([
				AGENDA.downloadUrl,
				MINUTES.downloadUrl,
			]),
		});
		expect(after.fiscalDecisions.map((d) => d.title)).toEqual([
			"Regenerated decision",
		]);
		expect(after.budgetDiscussions.map((d) => d.topic)).toEqual([
			"Regenerated discussion",
		]);
	});

	it("makes zero summarize calls and leaves every row unchanged on a second run with no new listings", async () => {
		const { rows, run } = await setup();
		await run({ egovListings: [AGENDA] });
		await run({ egovListings: [AGENDA, MINUTES] });
		const afterRegeneration = await rows();

		const { log, result } = await run({ egovListings: [AGENDA, MINUTES] });

		expect(log.summarize).toEqual([]);
		expect(result.errors).toBe(0);
		expect(await rows()).toEqual(afterRegeneration);
	});

	it("does not regenerate a meeting whose summary has no fingerprint when a run brings it no new source", async () => {
		const { db, rows, run } = await setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.storeMeeting({
					bodySlug: COUNCIL.slug,
					date: "2025-05-27",
					meetingType: "regular",
					documents: [
						{
							sourceUrl: AGENDA.downloadUrl,
							rawText: "Agenda text.",
							documentType: "agenda",
							extractionMethod: "text-layer",
						},
						{
							sourceUrl: MINUTES.downloadUrl,
							rawText: "Minutes text.",
							documentType: "minutes",
							extractionMethod: "text-layer",
						},
					],
					summary: { highlights: ["h"], prose: "p", model: "m" },
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);
		const before = await rows();
		expect(before.summaries[0].sourceFingerprint).toBe("");

		const { log } = await run({ egovListings: [AGENDA, MINUTES] });

		expect(log.summarize).toEqual([]);
		expect(await rows()).toEqual(before);
	});

	it("regenerates a meeting whose summary has no fingerprint once a listing brings it a new document", async () => {
		const { db, rows, run } = await setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.storeMeeting({
					bodySlug: COUNCIL.slug,
					date: "2025-05-27",
					meetingType: "regular",
					documents: [
						{
							sourceUrl: AGENDA.downloadUrl,
							rawText: "Agenda text.",
							documentType: "agenda",
							extractionMethod: "text-layer",
						},
					],
					summary: { highlights: ["h"], prose: "p", model: "m" },
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);

		const { log } = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationResult: REGENERATED,
		});

		expect(log.summarize).toHaveLength(1);
		const after = await rows();
		expect(after.summaries).toHaveLength(1);
		expect(after.summaries[0].highlights).toEqual(["Regenerated highlight"]);
	});

	it("reads a documents-only summary stored without kinds as built from the documents when a transcript attached by a one-shot sits beside them and regeneration fails", async () => {
		const { db, run } = await setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				const stored = yield* storage.storeMeeting({
					bodySlug: COUNCIL.slug,
					date: "2025-05-27",
					meetingType: "regular",
					documents: [
						{
							sourceUrl: AGENDA.downloadUrl,
							rawText: "Agenda text.",
							documentType: "agenda",
							extractionMethod: "text-layer",
						},
					],
					summary: { highlights: ["h"], prose: "p", model: "m" },
				});
				yield* storage.storeTranscript({
					meetingId: stored.id,
					source: "captions",
					rawText: "transcript text",
					sourceUrl: "https://www.youtube.com/watch?v=one-shot",
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);

		const { result } = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationFailsWhen: () => true,
		});

		expect(result.errors).toBe(1);
		const [stale] = await db.select().from(schema.summaries).all();
		expect(stale.prose).toBe("p");
		expect(stale.sourceKinds).toEqual(["documents"]);
		const page = await getMeetingByBodyAndDateQuery(
			db,
			COUNCIL.slug,
			"2025-05-27",
		);
		expect(page?.summarySources).toEqual({ origin: "documents" });
	});

	it("keeps the previous summary when regeneration fails, and regenerates on the next run", async () => {
		const { rows, run } = await setup();
		await run({ egovListings: [AGENDA] });
		const before = await rows();

		const failed = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationError: new Error("quota exceeded"),
		});

		expect(failed.result.errors).toBe(1);
		expect(failed.log.alert).toHaveLength(1);
		const afterFailure = await rows();
		expect(afterFailure.summaries).toEqual(before.summaries);
		expect(afterFailure.fiscalDecisions).toEqual(before.fiscalDecisions);

		const retried = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationResult: REGENERATED,
		});

		expect(retried.log.summarize).toHaveLength(1);
		expect((await rows()).summaries[0].highlights).toEqual([
			"Regenerated highlight",
		]);
	});

	it("regenerates a legacy meeting on the next run when regeneration failed after its new document was attached", async () => {
		const { db, rows, run } = await setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.storeMeeting({
					bodySlug: COUNCIL.slug,
					date: "2025-05-27",
					meetingType: "regular",
					documents: [
						{
							sourceUrl: AGENDA.downloadUrl,
							rawText: "Agenda text.",
							documentType: "agenda",
							extractionMethod: "text-layer",
						},
					],
					summary: { highlights: ["h"], prose: "p", model: "m" },
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);

		const failed = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationError: new Error("quota exceeded"),
		});
		expect(failed.result.errors).toBe(1);
		expect((await rows()).summaries[0].highlights).toEqual(["h"]);

		const retried = await run({
			egovListings: [AGENDA, MINUTES],
			summarizationResult: REGENERATED,
		});

		expect(retried.log.summarize).toHaveLength(1);
		expect((await rows()).summaries[0].highlights).toEqual([
			"Regenerated highlight",
		]);
	});

	it("attaches a new Finalsite document to a meeting that already has documents and regenerates from all of them", async () => {
		const { rows, run } = await setup();
		const document = (name: "agenda" | "minutes") => ({
			uuid: `uuid-${name}`,
			documentType: name,
			downloadUrl: `/fs/resource-manager/view/uuid-${name}`,
			fileName: `${name}.pdf`,
		});
		const listing = (
			...documents: ReturnType<typeof document>[]
		): FinalsiteMeetingListing => ({
			date: "January 20, 2026",
			meetingType: "Regular Meeting",
			year: 2026,
			documents,
		});
		await run({ finalsiteListings: [listing(document("agenda"))] }, BOARD);

		const second = await run(
			{
				finalsiteListings: [listing(document("agenda"), document("minutes"))],
				summarizationResult: REGENERATED,
			},
			BOARD,
		);

		expect(second.result.errors).toBe(0);
		expect(second.log.summarize).toHaveLength(1);
		const after = await rows();
		expect(after.documents).toHaveLength(2);
		expect(second.log.summarize[0].sources.map((s) => s.text)).toEqual(
			after.documents.map((d) => d.rawText),
		);
		expect(after.summaries).toHaveLength(1);
		expect(after.summaries[0]).toMatchObject({
			highlights: ["Regenerated highlight"],
			sourceFingerprint: computeSourceFingerprint(
				after.documents.map((d) => d.sourceUrl),
			),
		});

		const third = await run(
			{ finalsiteListings: [listing(document("agenda"), document("minutes"))] },
			BOARD,
		);

		expect(third.log.summarize).toEqual([]);
		expect(await rows()).toEqual(after);
	});

	it("holds a misdated eGov listing for a meeting that already holds a document, without attaching it or rebuilding the summary", async () => {
		const { rows, run } = await setup();
		await run({ egovListings: [AGENDA] });
		const before = await rows();

		const { log, result } = await run({
			egovListings: [AGENDA, MINUTES],
			// The title says May 27; the document opens with April 28.
			extractedText:
				"April 28, 2025 The Town Council met for a regular meeting on Monday, April 28, 2025.",
			summarizationResult: REGENERATED,
		});

		expect(log.egovDownload).toEqual([MINUTES.downloadUrl]);
		expect(log.summarize).toEqual([]);
		expect(log.store).toEqual([]);
		expect(log.alert).toHaveLength(1);
		expect(log.alert[0].body).toContain("2025-04-28");
		expect(result).toEqual({ processed: 0, errors: 1 });
		expect(await rows()).toEqual(before);
	});

	describe("an eGov listing whose document the meeting already holds", () => {
		it("is not downloaded again and spends no crawl delay", async () => {
			const { rows, run } = await setup();
			await run({ egovListings: [AGENDA] });
			const before = await rows();

			const { log, result, sleeps } = await run({
				egovListings: [AGENDA],
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([]);
			expect(sleeps).toEqual([]);
			expect(result).toEqual({ processed: 0, errors: 0 });
			expect(await rows()).toEqual(before);
		});

		it("leaves the download and one crawl delay to the listing beside it that the meeting does not hold", async () => {
			const { rows, run } = await setup();
			await run({ egovListings: [AGENDA] });

			const { log, result, sleeps } = await run({
				egovListings: [AGENDA, MINUTES],
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([MINUTES.downloadUrl]);
			expect(sleeps).toEqual([300_000]);
			expect(result).toEqual({ processed: 1, errors: 0 });
			expect((await rows()).documents.map((d) => d.sourceUrl)).toEqual([
				AGENDA.downloadUrl,
				MINUTES.downloadUrl,
			]);
		});

		it("is not downloaded again when it was stored unreadable", async () => {
			const { rows, run } = await setup();
			await run({ egovListings: [MINUTES] }, COUNCIL, true);
			const before = await rows();
			expect(before.documents.map((d) => d.extractionMethod)).toEqual([
				"unreadable",
			]);

			const { log, sleeps } = await run({
				egovListings: [MINUTES],
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([]);
			expect(sleeps).toEqual([]);
			expect(await rows()).toEqual(before);
		});

		it("still rebuilds a summary a failed run left behind, without downloading", async () => {
			const { rows, run } = await setup();
			await run({ egovListings: [AGENDA] });
			await run({
				egovListings: [AGENDA, MINUTES],
				summarizationError: new Error("quota exceeded"),
			});

			const { log, result, sleeps } = await run({
				egovListings: [AGENDA, MINUTES],
				summarizationResult: REGENERATED,
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([]);
			expect(sleeps).toEqual([]);
			expect(result.errors).toBe(0);
			expect(log.summarize).toHaveLength(1);
			expect((await rows()).summaries[0]).toMatchObject({
				highlights: ["Regenerated highlight"],
				sourceFingerprint: computeSourceFingerprint([
					AGENDA.downloadUrl,
					MINUTES.downloadUrl,
				]),
			});
		});

		it("spends no crawl delay when the summary rebuild for a skipped listing fails", async () => {
			const { run } = await setup();
			await run({ egovListings: [AGENDA] });
			await run({
				egovListings: [AGENDA, MINUTES],
				summarizationError: new Error("quota exceeded"),
			});

			const { log, result, sleeps } = await run({
				egovListings: [AGENDA, MINUTES],
				summarizationError: new Error("quota exceeded"),
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([]);
			expect(result.errors).toBe(2);
			expect(sleeps).toEqual([]);
		});

		it("logs egov.listing.skipped with the meeting, its date, the url and a reason", async () => {
			const { db, run } = await setup();
			await run({ egovListings: [AGENDA] });
			const [meeting] = await db.select().from(schema.meetings).all();

			const { captured } = await run({ egovListings: [AGENDA] });

			expect(
				findStageLog(captured, "egov.listing.skipped")?.annotations,
			).toMatchObject({
				body: COUNCIL.slug,
				source: "egov",
				url: AGENDA.downloadUrl,
				meetingId: meeting.id,
				date: "2025-05-27",
				reason: "already-stored",
			});
		});

		it("is downloaded when the same url is held only by another meeting", async () => {
			const { run } = await setup();
			await run({ egovListings: [AGENDA] });

			const { log } = await run({
				egovListings: [{ ...AGENDA, meetingDate: "2025-06-10" }],
			});

			expect(log.egovDownload).toEqual([AGENDA.downloadUrl]);
		});
	});

	describe("a listing for a meeting that has a transcript and no documents", () => {
		const VIDEO_URL = "https://www.youtube.com/watch?v=council-video";
		const FROM_VIDEO: MatchableSummary = {
			highlights: ["From the video"],
			prose: "Prose from the video",
			fiscalDecisions: [{ title: "Video decision", originalAmount: "$5" }],
		};
		const HOLD: MatchResult = {
			outcome: "hold",
			reason: "check-failed",
			probability: 0.02,
			sharedIdentifiers: 0,
		};

		/** A meeting stored from a video alone, with its drama assessment. */
		async function seedVideoMeeting(
			db: Awaited<ReturnType<typeof createMigratedTestDb>>,
			key: { bodySlug: string; date: string; session?: string },
			sourceFingerprint = computeSourceFingerprint([VIDEO_URL]),
		) {
			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					const categoryScores = {
						procedural_breakdown: { score: 0, evidenceQuotes: [] },
						question_looping: { score: 0, evidenceQuotes: [] },
						unanswered_questions: { score: 0, evidenceQuotes: [] },
						undecided_time: { score: 0, evidenceQuotes: [] },
						improvised_workarounds: { score: 0, evidenceQuotes: [] },
						repeat_deferrals: { score: 0, evidenceQuotes: [] },
						post_hoc_corrections: { score: 0, evidenceQuotes: [] },
					} satisfies Record<ScoredDramaCategory, DramaCategoryScoreInput>;
					const stored = yield* storage.storeMeeting({
						...key,
						meetingType: "regular",
						documents: [],
						summary: {
							highlights: FROM_VIDEO.highlights,
							prose: FROM_VIDEO.prose,
							model: "m",
							sourceKinds: ["transcript"],
							sourceFingerprint,
						},
						fiscalDecisions: [
							{
								...REGENERATED.fiscalDecisions[0],
								title: "Video decision",
								originalAmount: "$5",
							},
						],
					});
					yield* storage.storeTranscript({
						meetingId: stored.id,
						source: "captions",
						rawText: "transcript text",
						sourceUrl: VIDEO_URL,
					});
					yield* storage.storeDramaAssessment({
						meetingId: stored.id,
						level: "routine",
						confidence: 0.8,
						promptVersion: "v1",
						model: "m",
						headline: "Routine meeting",
						narrative: "Nothing notable.",
						categoryScores,
					});
					return stored;
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
			return meeting.id;
		}

		const COUNCIL_MEETING = { bodySlug: COUNCIL.slug, date: "2025-05-27" };

		/** Every row a video contributes to a meeting, and the holds. */
		const videoRows = async (
			db: Awaited<ReturnType<typeof createMigratedTestDb>>,
		) => ({
			transcripts: await db.select().from(schema.transcripts).all(),
			drama: await db.select().from(schema.dramaAssessments).all(),
			dramaScores: await db.select().from(schema.dramaCategoryScores).all(),
			held: await db.select().from(schema.heldVideos).all(),
		});

		it("attaches the documents and replaces the summary with one built from both kinds when the check returns match, keeping the transcript and drama assessment", async () => {
			const { db, rows, run } = await setup();
			const meetingId = await seedVideoMeeting(db, COUNCIL_MEETING);
			const videoBefore = await videoRows(db);

			const { log, result } = await run({
				egovListings: [MINUTES],
				summarizationResult: REGENERATED,
			});

			expect(result).toEqual({ processed: 1, errors: 0 });
			expect(log.match).toHaveLength(1);
			expect(log.match[0].transcriptSummary).toEqual(FROM_VIDEO);
			expect(log.match[0].documentsSummary).toMatchObject({
				highlights: REGENERATED.highlights,
			});
			// Once for the check, once for the summary that is stored.
			expect(log.summarize.map((c) => c.sources.map((s) => s.kind))).toEqual([
				["documents"],
				["documents", "transcript"],
			]);
			const after = await rows();
			expect(after.documents.map((d) => [d.meetingId, d.sourceUrl])).toEqual([
				[meetingId, MINUTES.downloadUrl],
			]);
			expect(after.summaries).toHaveLength(1);
			expect(after.summaries[0]).toMatchObject({
				meetingId,
				highlights: REGENERATED.highlights,
				sourceKinds: ["documents", "transcript"],
				sourceFingerprint: computeSourceFingerprint([
					MINUTES.downloadUrl,
					VIDEO_URL,
				]),
			});
			expect(await videoRows(db)).toEqual(videoBefore);
			expect(videoBefore.transcripts).toHaveLength(1);
			expect(videoBefore.drama).toHaveLength(1);
		});

		it("attaches the documents, takes the documents-only summary, detaches the transcript with its drama assessment and holds the video when the check returns hold", async () => {
			const { db, rows, run } = await setup();
			const meetingId = await seedVideoMeeting(db, COUNCIL_MEETING);

			const { log, result } = await run({
				egovListings: [MINUTES],
				summarizationResult: REGENERATED,
				matchResult: HOLD,
			});

			expect(result).toEqual({ processed: 1, errors: 0 });
			// The documents' own summary is the one stored; nothing is rebuilt.
			expect(log.summarize.map((c) => c.sources.map((s) => s.kind))).toEqual([
				["documents"],
			]);
			const after = await rows();
			expect(after.documents.map((d) => [d.meetingId, d.sourceUrl])).toEqual([
				[meetingId, MINUTES.downloadUrl],
			]);
			expect(after.summaries).toHaveLength(1);
			expect(after.summaries[0]).toMatchObject({
				meetingId,
				highlights: REGENERATED.highlights,
				prose: REGENERATED.prose,
				sourceKinds: ["documents"],
				sourceFingerprint: computeSourceFingerprint([MINUTES.downloadUrl]),
			});
			expect(after.fiscalDecisions.map((d) => d.title)).toEqual([
				"Regenerated decision",
			]);
			const video = await videoRows(db);
			expect(video.transcripts).toEqual([]);
			expect(video.drama).toEqual([]);
			expect(video.dramaScores).toEqual([]);
			expect(video.held).toHaveLength(1);
			expect(video.held[0]).toMatchObject({
				videoId: "council-video",
				reason: "check-failed",
				probability: 0.02,
				sharedIdentifiers: 0,
				meetingDate: "2025-05-27",
				candidateMeetingId: meetingId,
			});
			expect(log.alert.filter((a) => a.subject.includes("held"))).toHaveLength(
				1,
			);
		});

		/** A video-only meeting whose summary recorded neither kinds nor a fingerprint. */
		async function seedVideoMeetingWithoutKinds(
			db: Awaited<ReturnType<typeof createMigratedTestDb>>,
		) {
			const meetingId = await seedVideoMeeting(db, COUNCIL_MEETING, "");
			await db.update(schema.summaries).set({ sourceKinds: [] }).run();
			return meetingId;
		}

		it("still reads a summary stored without kinds as built from the video, with its link, when regeneration fails after a PDF is attached", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeetingWithoutKinds(db);

			const { result } = await run({
				egovListings: [MINUTES],
				summarizationFailsWhen: (input) => input.sources.length > 1,
			});

			expect(result.errors).toBe(1);
			const after = await rows();
			expect(after.documents.map((d) => d.sourceUrl)).toEqual([
				MINUTES.downloadUrl,
			]);
			expect(after.summaries[0].prose).toBe(FROM_VIDEO.prose);
			const page = await getMeetingByBodyAndDateQuery(
				db,
				COUNCIL.slug,
				COUNCIL_MEETING.date,
			);
			expect(page?.summarySources).toEqual({
				origin: "video",
				videoUrl: VIDEO_URL,
			});
		});

		it("reads a summary stored without kinds as built from the video while the documents' summary has not replaced it after a hold", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeetingWithoutKinds(db);
			const live = StorageServiceLive(db);
			const replaceFails = Layer.effect(
				StorageService,
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return {
						...storage,
						replaceMeetingSummary: () =>
							Effect.fail(
								new DatabaseError({
									operation: "replaceMeetingSummary",
									message: "database unavailable",
								}),
							),
					};
				}),
			).pipe(Layer.provide(live));

			const { result } = await run({
				egovListings: [MINUTES],
				matchResult: HOLD,
				storage: replaceFails,
			});

			expect(result.errors).toBe(1);
			const after = await rows();
			expect(after.documents.map((d) => d.sourceUrl)).toEqual([
				MINUTES.downloadUrl,
			]);
			expect(after.summaries[0].prose).toBe(FROM_VIDEO.prose);
			const page = await getMeetingByBodyAndDateQuery(
				db,
				COUNCIL.slug,
				COUNCIL_MEETING.date,
			);
			// The held video's transcript is detached, so there is no link to give.
			expect(page?.summarySources).toEqual({ origin: "video", videoUrl: null });
		});

		it("counts an error and leaves the transcript, summary and documents exactly as they were when the check fails, and checks again on the next run", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING);
			const before = { ...(await rows()), ...(await videoRows(db)) };
			const config = {
				egovListings: [MINUTES],
				matchResult: new MeetingMatchError({ message: "model unavailable" }),
			};

			const first = await run(config);

			expect(first.result).toEqual({ processed: 0, errors: 1 });
			expect({ ...(await rows()), ...(await videoRows(db)) }).toEqual(before);
			expect(before.documents).toEqual([]);
			expect(before.held).toEqual([]);

			const second = await run(config);

			expect(second.log.match).toHaveLength(1);
		});

		it("[QA-RELI] does not transcribe or attach a video again on the next video run after the PDF path detached and held it", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING);
			const body = {
				...COUNCIL,
				youtubePlaylistId: "PL_council",
				youtubeTitlePrefix: "Town Council",
			};
			const video: YouTubeVideo = {
				videoId: "council-video",
				title: "Town Council, May 27, 2025",
				publishedAt: "2025-05-29T00:00:00Z",
				hasCaptions: true,
			};

			await run({ egovListings: [MINUTES], matchResult: HOLD }, body);
			const afterPdf = { ...(await rows()), ...(await videoRows(db)) };
			expect(afterPdf.transcripts).toEqual([]);
			expect(afterPdf.held.map((h) => h.videoId)).toEqual(["council-video"]);

			const videoRun = await run({ youtubeVideos: [video] }, body);

			expect(videoRun.log.youtubeList).toEqual(["PL_council"]);
			expect(videoRun.log.transcribe).toEqual([]);
			expect(videoRun.log.match).toEqual([]);
			expect({ ...(await rows()), ...(await videoRows(db)) }).toEqual(afterPdf);
		});

		it("downloads the listing again on the next run when the check failed and nothing was stored", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING);

			const failed = await run({
				egovListings: [MINUTES],
				matchResult: new MeetingMatchError({ message: "model unavailable" }),
			});
			expect(failed.result.errors).toBe(1);
			expect((await rows()).documents).toEqual([]);

			const { log, sleeps } = await run({
				egovListings: [MINUTES],
				crawlDelayMs: 300_000,
			});

			expect(log.egovDownload).toEqual([MINUTES.downloadUrl]);
			expect(sleeps).toEqual([300_000]);
			expect((await rows()).documents.map((d) => d.sourceUrl)).toEqual([
				MINUTES.downloadUrl,
			]);
		});

		it("downloads the listing again on the next run when it was unreadable and skipped for the video", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING);
			await run({ egovListings: [MINUTES] }, COUNCIL, true);
			expect((await rows()).documents).toEqual([]);

			const { log } = await run({ egovListings: [MINUTES] });

			expect(log.egovDownload).toEqual([MINUTES.downloadUrl]);
			expect((await rows()).documents.map((d) => d.sourceUrl)).toEqual([
				MINUTES.downloadUrl,
			]);
		});

		it("[QA-MAINT] emits egov.match.start and egov.match.finish with the outcome, probability and shared identifiers", async () => {
			const { db, run } = await setup();
			const meetingId = await seedVideoMeeting(db, COUNCIL_MEETING);

			const { captured } = await run({
				egovListings: [MINUTES],
				matchResult: HOLD,
			});

			expect(
				findStageLog(captured, "egov.match.start")?.annotations,
			).toMatchObject({ body: COUNCIL.slug, source: "egov", meetingId });
			expect(
				findStageLog(captured, "egov.match.finish")?.annotations,
			).toMatchObject({
				meetingId,
				outcome: "hold",
				probability: 0.02,
				sharedIdentifiers: 0,
			});
		});

		it.each([
			["stored without a fingerprint", ""],
			["stored with the video's fingerprint", undefined],
		])("takes the documents-only summary on a later run when attaching the documents failed after the transcript was detached, for a summary %s", async (_name, fingerprint) => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING, fingerprint);
			const config = {
				egovListings: [MINUTES],
				summarizationResult: REGENERATED,
				matchResult: HOLD,
			};
			const attachFails = Layer.effect(
				StorageService,
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return {
						...storage,
						storeMeeting: () =>
							Effect.fail(
								new DatabaseError({
									operation: "storeMeeting",
									message: "database unavailable",
								}),
							),
					};
				}),
			).pipe(Layer.provide(StorageServiceLive(db)));

			const failed = await run({ ...config, storage: attachFails });
			expect(failed.result.errors).toBe(1);
			expect((await videoRows(db)).transcripts).toEqual([]);
			expect((await rows()).documents).toEqual([]);

			await run(config);
			await run(config);

			const after = await rows();
			expect(after.documents.map((d) => d.sourceUrl)).toEqual([
				MINUTES.downloadUrl,
			]);
			expect(after.summaries).toHaveLength(1);
			expect(after.summaries[0]).toMatchObject({
				highlights: REGENERATED.highlights,
				sourceKinds: ["documents"],
			});
			expect((await videoRows(db)).held).toHaveLength(1);
		});

		it("leaves a meeting with a transcript and no documents untouched for an unreadable document, so a later readable one is still checked against the video", async () => {
			const { db, rows, run } = await setup();
			await seedVideoMeeting(db, COUNCIL_MEETING);
			const before = { ...(await rows()), ...(await videoRows(db)) };

			const unreadable = await run({ egovListings: [MINUTES] }, COUNCIL, true);

			expect(unreadable.result.errors).toBe(0);
			expect({ ...(await rows()), ...(await videoRows(db)) }).toEqual(before);

			const readable = await run({
				egovListings: [MINUTES],
				summarizationResult: REGENERATED,
				matchResult: HOLD,
			});

			expect(readable.log.match).toHaveLength(1);
			const video = await videoRows(db);
			expect(video.transcripts).toEqual([]);
			expect(video.held).toHaveLength(1);
		});

		it("logs egov.listing.skipped with the meeting and a reason when an unreadable document is skipped for a meeting that has a transcript and no documents", async () => {
			const { db, run } = await setup();
			const meetingId = await seedVideoMeeting(db, COUNCIL_MEETING);

			const { captured } = await run(
				{ egovListings: [MINUTES] },
				COUNCIL,
				true,
			);

			expect(
				findStageLog(captured, "egov.listing.skipped")?.annotations,
			).toMatchObject({
				meetingId,
				date: COUNCIL_MEETING.date,
				reason: "unreadable-for-video-only-meeting",
			});
		});

		describe("on the Finalsite path", () => {
			const LISTING: FinalsiteMeetingListing = {
				date: "January 20, 2026",
				meetingType: "Regular Meeting",
				year: 2026,
				documents: [
					{
						uuid: "uuid-minutes",
						documentType: "minutes",
						downloadUrl: "/fs/resource-manager/view/uuid-minutes",
						fileName: "minutes.pdf",
					},
				],
			};
			const BOARD_MEETING = {
				bodySlug: BOARD.slug,
				date: "2026-01-20",
				session: "regular-meeting",
			};

			it("attaches the documents to the session's meeting and rebuilds the summary from both kinds when the check returns match", async () => {
				const { db, rows, run } = await setup();
				const meetingId = await seedVideoMeeting(db, BOARD_MEETING);
				// The same date under another session is a different meeting.
				const otherId = await seedVideoMeeting(db, {
					...BOARD_MEETING,
					session: "work-session",
				});
				const videoBefore = await videoRows(db);

				const { log, result, captured } = await run(
					{ finalsiteListings: [LISTING], summarizationResult: REGENERATED },
					BOARD,
				);

				expect(result).toEqual({ processed: 1, errors: 0 });
				expect(log.match).toHaveLength(1);
				const after = await rows();
				expect(after.documents.map((d) => d.meetingId)).toEqual([meetingId]);
				expect(
					after.summaries.map((s) => [s.meetingId, s.sourceKinds]).sort(),
				).toEqual([
					[meetingId, ["documents", "transcript"]],
					[otherId, ["transcript"]],
				]);
				expect(await videoRows(db)).toEqual(videoBefore);
				expect(
					findStageLog(captured, "finalsite.match.finish")?.annotations,
				).toMatchObject({ meetingId, outcome: "match" });
			});

			it("leaves a meeting with a transcript and no documents untouched for an all-unreadable listing, so a later readable one is still checked against the video", async () => {
				const { db, rows, run } = await setup();
				await seedVideoMeeting(db, BOARD_MEETING);
				const before = { ...(await rows()), ...(await videoRows(db)) };

				const unreadable = await run(
					{ finalsiteListings: [LISTING] },
					BOARD,
					true,
				);

				expect(unreadable.result.errors).toBe(0);
				expect({ ...(await rows()), ...(await videoRows(db)) }).toEqual(before);

				const readable = await run(
					{
						finalsiteListings: [LISTING],
						summarizationResult: REGENERATED,
						matchResult: HOLD,
					},
					BOARD,
				);

				expect(readable.log.match).toHaveLength(1);
				const video = await videoRows(db);
				expect(video.transcripts).toEqual([]);
				expect(video.held).toHaveLength(1);
			});

			it("logs finalsite.listing.skipped with the meeting and a reason when an all-unreadable listing is skipped for a meeting that has a transcript and no documents", async () => {
				const { db, run } = await setup();
				const meetingId = await seedVideoMeeting(db, BOARD_MEETING);

				const { captured } = await run(
					{ finalsiteListings: [LISTING] },
					BOARD,
					true,
				);

				expect(
					findStageLog(captured, "finalsite.listing.skipped")?.annotations,
				).toMatchObject({
					meetingId,
					date: BOARD_MEETING.date,
					session: BOARD_MEETING.session,
					reason: "unreadable-for-video-only-meeting",
				});
			});

			it("takes the documents-only summary, detaches the transcript with its drama assessment and holds the video when the check returns hold", async () => {
				const { db, rows, run } = await setup();
				const meetingId = await seedVideoMeeting(db, BOARD_MEETING);

				const { result, captured } = await run(
					{
						finalsiteListings: [LISTING],
						summarizationResult: REGENERATED,
						matchResult: { ...HOLD, reason: "signals-disagree" },
					},
					BOARD,
				);

				expect(result).toEqual({ processed: 1, errors: 0 });
				const after = await rows();
				expect(after.documents.map((d) => d.meetingId)).toEqual([meetingId]);
				expect(after.summaries).toHaveLength(1);
				expect(after.summaries[0]).toMatchObject({
					meetingId,
					highlights: REGENERATED.highlights,
					sourceKinds: ["documents"],
					sourceFingerprint: computeSourceFingerprint(
						after.documents.map((d) => d.sourceUrl),
					),
				});
				const video = await videoRows(db);
				expect(video.transcripts).toEqual([]);
				expect(video.drama).toEqual([]);
				expect(video.dramaScores).toEqual([]);
				expect(video.held).toHaveLength(1);
				expect(video.held[0]).toMatchObject({
					videoId: "council-video",
					reason: "signals-disagree",
					meetingDate: "2026-01-20",
					candidateMeetingId: meetingId,
				});
				expect(
					findStageLog(captured, "finalsite.match.start")?.annotations,
				).toMatchObject({ meetingId, source: "finalsite" });
				expect(
					findStageLog(captured, "finalsite.match.finish")?.annotations,
				).toMatchObject({
					meetingId,
					outcome: "hold",
					probability: 0.02,
					sharedIdentifiers: 0,
				});
			});
		});
	});
});

describe("videoIdFromUrl", () => {
	it("reads back the id that videoUrl put in the stored URL", () => {
		for (const id of ["dQw4w9WgXcQ", "a-b_c1234XY", "-0123456789"]) {
			expect(videoIdFromUrl(videoUrl(id))).toBe(id);
		}
	});

	it("reads the id when v is not the first query parameter", () => {
		expect(videoIdFromUrl("https://www.youtube.com/watch?t=5&v=abc123")).toBe(
			"abc123",
		);
	});

	it("returns undefined when the URL carries no video id", () => {
		expect(videoIdFromUrl("https://example.com/minutes.pdf")).toBeUndefined();
	});
});
