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
import type {
	Meeting,
	MeetingInput,
} from "#/pipeline/services/StorageService.ts";
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
	storeInputs: Array<MeetingInput>;
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
		storeInputs: [],
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
				config.log.storeInputs.push(input);
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
				},
				{
					id: 1653,
					title:
						"Reorganization Board Meeting February 4, 2026 Minutes Approved",
					date: "02/04/2026",
					downloadUrl: "https://example.com/doc/1653",
				},
				{
					id: 1627,
					title: "Town Council Meeting Minutes December 8, 2025",
					date: "12/08/2025",
					downloadUrl: "https://example.com/doc/1627",
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
		expect(log.summarize[0].sourceText).toContain("transcript for abc123");
		expect(log.store).toHaveLength(1);
		expect(result.processed).toBe(1);
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
		expect(log.summarize[0].sourceText).toContain("$10,000");

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
