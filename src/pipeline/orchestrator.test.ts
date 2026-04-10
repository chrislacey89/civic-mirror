import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MeetingDetail } from "#/db/queries.ts";
import { LlmError } from "#/pipeline/errors.ts";
import { runPipeline } from "#/pipeline/orchestrator.ts";
import { AlertService } from "#/pipeline/services/AlertService.ts";
import type { FinalsiteMeetingListing } from "#/pipeline/services/FinalsiteScraper.ts";
import { FinalsiteScraper } from "#/pipeline/services/FinalsiteScraper.ts";
import type { EgovDocumentListing } from "#/pipeline/services/ScraperService.ts";
import { EgovScraper } from "#/pipeline/services/ScraperService.ts";
import type { Meeting } from "#/pipeline/services/StorageService.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import type { SummarizationResult } from "#/pipeline/services/SummarizationService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import { TranscriptionService } from "#/pipeline/services/TranscriptionService.ts";
import type { YouTubeVideo } from "#/pipeline/services/YouTubeScraper.ts";
import { YouTubeScraper } from "#/pipeline/services/YouTubeScraper.ts";

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
	summarize: Array<{ sourceText: string; meetingContext: string }>;
	store: Array<{ bodySlug: string; date: string }>;
	alert: Array<{ subject: string; body: string }>;
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
		alert: [],
	};
}

type StubConfig = {
	log: CallLog;
	egovListings?: EgovDocumentListing[];
	finalsiteListings?: FinalsiteMeetingListing[];
	youtubeVideos?: YouTubeVideo[];
	summarizationResult?: SummarizationResult;
	summarizationError?: Error;
	storedMeeting?: Meeting;
	lastMeetingLookup?: MeetingDetail | null;
	mostRecentMeetingDate?: string | null;
};

function buildStubLayers(config: StubConfig) {
	const defaultSummary: SummarizationResult = {
		highlights: ["A highlight"],
		prose: "A prose summary",
		fiscalDecisions: [],
		budgetDiscussions: [],
		model: "stub-model",
	};
	const defaultMeeting: Meeting = { id: 1, date: "2026-01-01", bodyId: 1 };

	const egov = Layer.succeed(EgovScraper, {
		scrapeListings: () =>
			Effect.sync(() => {
				config.log.egovScrape += 1;
				return config.egovListings ?? [];
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
			Effect.sync(() => {
				config.log.transcribe.push(videoId);
				return {
					source: "captions" as const,
					rawText: `transcript for ${videoId}`,
					segments: [],
				};
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
					return config.summarizationResult ?? defaultSummary;
				},
				catch: (error) =>
					new LlmError({
						model: "stub-model",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});

	const storage = Layer.succeed(StorageService, {
		storeMeeting: (input) =>
			Effect.sync(() => {
				config.log.store.push({ bodySlug: input.bodySlug, date: input.date });
				return config.storedMeeting ?? defaultMeeting;
			}),
		getMeetingByBodyAndDate: () =>
			Effect.sync(() => config.lastMeetingLookup ?? null),
		storeTranscript: () => Effect.void,
		getMostRecentMeetingDate: () =>
			Effect.sync(() => config.mostRecentMeetingDate ?? null),
	});

	const alert = Layer.succeed(AlertService, {
		sendAlert: (input) =>
			Effect.sync(() => {
				config.log.alert.push(input);
			}),
	});

	return Layer.mergeAll(
		egov,
		finalsite,
		youtube,
		transcription,
		summarization,
		storage,
		alert,
	);
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
				},
				{
					id: 1628,
					title: "Town Council Meeting January 14, 2026 Minutes",
					date: "01/14/2026",
					downloadUrl: "https://example.com/doc/1628",
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
			extractPdfText: async () =>
				"Meeting minutes body text with $50,000 decision",
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.egovScrape).toBe(1);
		expect(log.egovDownload).toHaveLength(2);
		expect(log.summarize).toHaveLength(2);
		expect(log.summarize[0].sourceText).toContain("$50,000");
		expect(log.store).toHaveLength(2);
		expect(log.store[0].bodySlug).toBe("town-council");
		expect(log.alert).toHaveLength(0);
		expect(result.processed).toBe(2);
		expect(result.errors).toBe(0);
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
				},
			],
		});

		const program = runPipeline({
			bodies: [{ slug: "body", name: "Body", egovSearchType: "12" }],
			crawlDelayMs: 0,
			youtubeDelayMs: 0,
			networkRetry: { attempts: 0, baseDelayMs: 0 },
			llmRetry: { attempts: 0, baseDelayMs: 0 },
			extractPdfText: async () => "text",
			dryRun: true,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.egovDownload).toHaveLength(1);
		expect(log.summarize).toHaveLength(1);
		expect(log.store).toHaveLength(0);
		expect(result.processed).toBe(1);
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
				},
				{
					id: 2,
					title: "Second",
					date: "01/02/2026",
					downloadUrl: "https://example.com/doc/2",
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
			extractPdfText: async () => "text",
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.summarize).toHaveLength(2);
		expect(log.store).toHaveLength(0);
		expect(log.alert.length).toBeGreaterThanOrEqual(1);
		expect(log.alert[0].subject).toContain("summarize");
		expect(result.errors).toBe(2);
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
			extractPdfText: async () => "school board text",
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.finalsiteDownload).toHaveLength(2);
		expect(log.store).toHaveLength(1);
		expect(log.store[0].bodySlug).toBe("school-board");
		expect(result.processed).toBe(1);
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
			extractPdfText: async () => "unused",
			dryRun: false,
		}).pipe(Effect.provide(layers));

		const result = await Effect.runPromise(program);

		expect(log.youtubeList).toEqual(["PL_test"]);
		expect(log.transcribe).toEqual(["abc123"]);
		expect(log.summarize).toHaveLength(1);
		expect(log.summarize[0].sourceText).toContain("transcript for abc123");
		expect(log.store).toHaveLength(1);
		expect(result.processed).toBe(1);
	});
});
