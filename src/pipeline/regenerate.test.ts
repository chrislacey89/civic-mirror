import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { LlmError } from "#/pipeline/errors.ts";
import {
	incompleteRegeneration,
	regenerateCombinedSummaries,
	regenerateMeetingSummary,
} from "#/pipeline/regenerate.ts";
import {
	type MeetingInput,
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import {
	type SummarizationInput,
	type SummarizationResult,
	SummarizationService,
} from "#/pipeline/services/SummarizationService.ts";
import { computeSourceFingerprint } from "#/pipeline/sources.ts";
import { createMigratedTestDb } from "#/pipeline/test-db.ts";

const AGENDA_URL = "https://example.com/doc/agenda";
const MINUTES_URL = "https://example.com/doc/minutes";
const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";

const AGENDA: MeetingInput["documents"][number] = {
	sourceUrl: AGENDA_URL,
	rawText: "Agenda: paving bids.",
	documentType: "agenda",
	extractionMethod: "text-layer",
};
const MINUTES: MeetingInput["documents"][number] = {
	sourceUrl: MINUTES_URL,
	rawText: "Minutes: accepted the paving bid of $215,215.10.",
	documentType: "minutes",
	extractionMethod: "text-layer",
};

const REGENERATED: SummarizationResult = {
	highlights: ["Accepted the paving bid"],
	prose: "The council accepted the paving bid.",
	fiscalDecisions: [
		{
			title: "Paving bid",
			description: "Accepted the low bid",
			amount: 215215.1,
			originalAmount: "$215,215.10",
			status: "approved",
			confidence: 0.9,
			isRecurring: false,
		},
	],
	budgetDiscussions: [{ topic: "Next year's paving" }],
	sourceDisagreements: [],
	model: "regenerating-model",
};

/** A database holding one meeting, and the layers `regenerateMeetingSummary` runs on. */
async function setup(options: {
	documents: MeetingInput["documents"];
	summarized?: boolean;
	result?: SummarizationResult;
	summarizeError?: Error;
	/** Fail only the summarize calls whose meeting context contains this text. */
	summarizeErrorFor?: string;
}) {
	const db = await createMigratedTestDb();
	await db
		.insert(schema.governingBodies)
		.values({ name: "Town Council", slug: "town-council", type: "town" })
		.run();

	const calls: SummarizationInput[] = [];
	const summarization = Layer.succeed(SummarizationService, {
		summarize: (input) =>
			Effect.suspend(() => {
				calls.push(input);
				return options.summarizeError &&
					(options.summarizeErrorFor === undefined ||
						input.meetingContext.includes(options.summarizeErrorFor))
					? Effect.fail(
							new LlmError({
								model: "regenerating-model",
								message: options.summarizeError.message,
							}),
						)
					: Effect.succeed(options.result ?? REGENERATED);
			}),
	});
	const layers = Layer.mergeAll(StorageServiceLive(db), summarization);

	const meeting = await Effect.runPromise(
		Effect.gen(function* () {
			const storage = yield* StorageService;
			return yield* storage.storeMeeting({
				bodySlug: "town-council",
				date: "2025-05-27",
				meetingType: "regular",
				documents: options.documents,
				...(options.summarized === false
					? {}
					: {
							summary: {
								highlights: ["Original highlight"],
								prose: "Original prose.",
								model: "original-model",
							},
							fiscalDecisions: [
								{
									title: "Original decision",
									description: "From the first summary",
									amount: 100,
									originalAmount: "$100",
									status: "approved" as const,
									confidence: 0.9,
									isRecurring: false,
								},
							],
							budgetDiscussions: [{ topic: "Original discussion" }],
						}),
			});
		}).pipe(Effect.provide(layers)),
	);

	// A summary stored by `storeMeeting` carries no fingerprint, which
	// `regenerateMeetingSummary` treats as not due. Stamp one that differs from
	// the sources held, as a summary built before a source arrived would have.
	if (options.summarized !== false) {
		await db
			.update(schema.summaries)
			.set({ sourceFingerprint: computeSourceFingerprint(["stale"]) })
			.where(eq(schema.summaries.meetingId, meeting.id))
			.run();
	}

	const regenerate = (options: { force?: boolean } = {}) =>
		Effect.runPromise(
			regenerateMeetingSummary({
				meetingId: meeting.id,
				meetingContext: "Town Council, 2025-05-27",
				glossary: undefined,
				...options,
			}).pipe(Effect.provide(layers)),
		);

	const rows = async () => ({
		summaries: await db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, meeting.id))
			.all(),
		fiscalDecisions: await db
			.select()
			.from(schema.fiscalDecisions)
			.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
			.all(),
		budgetDiscussions: await db
			.select()
			.from(schema.budgetDiscussions)
			.where(eq(schema.budgetDiscussions.meetingId, meeting.id))
			.all(),
	});

	return { db, meeting, calls, layers, regenerate, rows };
}

describe("regenerateMeetingSummary", () => {
	it("replaces the summary with one built from every document when the sources differ from the stored fingerprint", async () => {
		const { calls, regenerate, rows } = await setup({
			documents: [AGENDA, MINUTES],
		});

		const result = await regenerate();

		expect(result).toEqual({ regenerated: true });
		expect(calls).toEqual([
			{
				sources: [
					{ kind: "documents", text: AGENDA.rawText },
					{ kind: "documents", text: MINUTES.rawText },
				],
				meetingContext: "Town Council, 2025-05-27",
			},
		]);

		const after = await rows();
		expect(after.summaries).toHaveLength(1);
		expect(after.summaries[0]).toMatchObject({
			highlights: ["Accepted the paving bid"],
			prose: "The council accepted the paving bid.",
			model: "regenerating-model",
			sourceKinds: ["documents"],
			sourceFingerprint: computeSourceFingerprint([AGENDA_URL, MINUTES_URL]),
			sourceDisagreements: [],
		});
		expect(after.fiscalDecisions.map((d) => d.title)).toEqual(["Paving bid"]);
		expect(after.budgetDiscussions.map((d) => d.topic)).toEqual([
			"Next year's paving",
		]);
	});

	it("makes no summarize call and returns regenerated: false when the sources' fingerprint equals the stored one", async () => {
		const { calls, regenerate, rows } = await setup({
			documents: [AGENDA, MINUTES],
		});
		await regenerate();
		const afterFirst = await rows();

		const second = await regenerate();

		expect(second).toEqual({ regenerated: false });
		expect(calls).toHaveLength(1);
		expect(await rows()).toEqual(afterFirst);
	});

	it("summarizes again when forced, though the sources' fingerprint equals the stored one", async () => {
		const { calls, regenerate } = await setup({
			documents: [AGENDA, MINUTES],
		});
		await regenerate();

		const result = await regenerate({ force: true });

		expect(result).toEqual({ regenerated: true });
		expect(calls).toHaveLength(2);
	});

	it("keeps an unreadable document out of the summarizer's sources but counts its URL in the fingerprint", async () => {
		const scanUrl = "https://example.com/doc/scan";
		const { calls, regenerate, rows } = await setup({
			documents: [
				MINUTES,
				{
					sourceUrl: scanUrl,
					rawText: "",
					documentType: "ordinance",
					extractionMethod: "unreadable",
				},
			],
		});

		await regenerate();
		const second = await regenerate();

		expect(calls).toHaveLength(1);
		expect(calls[0].sources).toEqual([
			{ kind: "documents", text: MINUTES.rawText },
		]);
		expect((await rows()).summaries[0].sourceFingerprint).toBe(
			computeSourceFingerprint([MINUTES_URL, scanUrl]),
		);
		expect(second).toEqual({ regenerated: false });
	});

	it("summarizes the documents and the transcript together and stores the disagreements between them", async () => {
		const disagreement = {
			topic: "Paving bid",
			documentsSay: "$215,215.10",
			transcriptSays: "$244,215.10",
		};
		const { meeting, calls, layers, regenerate, rows } = await setup({
			documents: [MINUTES],
			result: { ...REGENERATED, sourceDisagreements: [disagreement] },
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.storeTranscript({
					meetingId: meeting.id,
					source: "captions",
					rawText: "the paving bid came in at $244,215.10",
					sourceUrl: VIDEO_URL,
				});
			}).pipe(Effect.provide(layers)),
		);

		const result = await regenerate();

		expect(result).toEqual({ regenerated: true });
		expect(calls[0].sources).toEqual([
			{ kind: "documents", text: MINUTES.rawText },
			{ kind: "transcript", text: "the paving bid came in at $244,215.10" },
		]);
		expect((await rows()).summaries[0]).toMatchObject({
			sourceKinds: ["documents", "transcript"],
			sourceFingerprint: computeSourceFingerprint([MINUTES_URL, VIDEO_URL]),
			sourceDisagreements: [disagreement],
		});
	});

	it("writes no summary and makes no summarize call for a meeting with no readable source", async () => {
		const { calls, regenerate, rows } = await setup({
			summarized: false,
			documents: [
				{
					sourceUrl: "https://example.com/doc/scan",
					rawText: "",
					documentType: "minutes",
					extractionMethod: "unreadable",
				},
			],
		});

		const result = await regenerate();

		expect(result).toEqual({ regenerated: false });
		expect(calls).toHaveLength(0);
		expect((await rows()).summaries).toHaveLength(0);
	});

	it("leaves the previous summary in place when the summarizer fails", async () => {
		const { regenerate, rows } = await setup({
			documents: [AGENDA, MINUTES],
			summarizeError: new Error("quota exceeded"),
		});
		const before = await rows();

		await expect(regenerate()).rejects.toThrow("quota exceeded");

		expect(await rows()).toEqual(before);
	});
	it("leaves a summary stored without a fingerprint alone, and regenerates it once stamped with the fingerprint of fewer sources", async () => {
		const { db, meeting, calls, layers, regenerate, rows } = await setup({
			documents: [AGENDA, MINUTES],
		});
		await db
			.update(schema.summaries)
			.set({ sourceFingerprint: "" })
			.where(eq(schema.summaries.meetingId, meeting.id))
			.run();
		const before = await rows();

		const untouched = await regenerate();

		expect(untouched).toEqual({ regenerated: false });
		expect(calls).toHaveLength(0);
		expect(await rows()).toEqual(before);

		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.stampSummarySources({
					meetingId: meeting.id,
					builtFrom: {
						documents: [{ sourceUrl: AGENDA_URL, rawText: "Agenda text." }],
					},
				});
			}).pipe(Effect.provide(layers)),
		);

		const stamped = await regenerate();

		expect(stamped).toEqual({ regenerated: true });
		expect(calls).toHaveLength(1);
	});
});

describe("regenerateCombinedSummaries", () => {
	const TRANSCRIPT_TEXT = "the paving bid came in at $244,215.10";

	/** Gives the setup's meeting a transcript and a summary built from both kinds. */
	async function combine(
		context: Pick<
			Awaited<ReturnType<typeof setup>>,
			"meeting" | "layers" | "regenerate"
		>,
	) {
		await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.storeTranscript({
					meetingId: context.meeting.id,
					source: "captions",
					rawText: TRANSCRIPT_TEXT,
					sourceUrl: VIDEO_URL,
				});
			}).pipe(Effect.provide(context.layers)),
		);
		await context.regenerate();
	}

	const regenerateAll = (
		layers: Awaited<ReturnType<typeof setup>>["layers"],
		date?: string,
	) =>
		Effect.runPromise(
			regenerateCombinedSummaries({
				body: { slug: "town-council", name: "Town Council" },
				date,
			}).pipe(Effect.provide(layers)),
		);

	it("summarizes again each meeting of the body whose summary was built from documents and a transcript", async () => {
		const context = await setup({ documents: [MINUTES] });
		await combine(context);
		context.calls.length = 0;

		const outcomes = await regenerateAll(context.layers);

		expect(outcomes).toEqual([
			{
				meetingId: context.meeting.id,
				date: "2025-05-27",
				outcome: "regenerated",
			},
		]);
		expect(context.calls).toEqual([
			{
				sources: [
					{ kind: "documents", text: MINUTES.rawText },
					{ kind: "transcript", text: TRANSCRIPT_TEXT },
				],
				meetingContext: "Town Council, 2025-05-27",
			},
		]);
	});

	it("leaves alone a meeting whose summary was built from documents only", async () => {
		const context = await setup({ documents: [MINUTES] });
		await context.regenerate();
		context.calls.length = 0;

		const outcomes = await regenerateAll(context.layers);

		expect(outcomes).toEqual([]);
		expect(context.calls).toHaveLength(0);
	});

	it("regenerates only the meeting on the given date", async () => {
		const context = await setup({ documents: [MINUTES] });
		await combine(context);
		context.calls.length = 0;

		const otherDate = await regenerateAll(context.layers, "2025-06-09");
		const thatDate = await regenerateAll(context.layers, "2025-05-27");

		expect(otherDate).toEqual([]);
		expect(thatDate.map((o) => o.outcome)).toEqual(["regenerated"]);
		expect(context.calls).toHaveLength(1);
	});

	it("reports a summarizer failure and leaves that meeting's summary in place", async () => {
		const context = await setup({
			documents: [MINUTES],
			summarizeError: new Error("quota exceeded"),
		});
		await context.db
			.update(schema.summaries)
			.set({ sourceKinds: ["documents", "transcript"] })
			.where(eq(schema.summaries.meetingId, context.meeting.id))
			.run();
		const before = await context.rows();

		const outcomes = await regenerateAll(context.layers);

		expect(outcomes).toEqual([
			{
				meetingId: context.meeting.id,
				date: "2025-05-27",
				outcome: "failed",
				message: "quota exceeded",
			},
		]);
		expect(await context.rows()).toEqual(before);
	});

	/** Stores a meeting whose summary was built from documents and a transcript. */
	async function storeCombinedMeeting(
		context: Pick<Awaited<ReturnType<typeof setup>>, "db" | "layers">,
		bodySlug: string,
		date: string,
	) {
		const meeting = await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.storeMeeting({
					bodySlug,
					date,
					meetingType: "regular",
					documents: [MINUTES],
					summary: {
						highlights: ["Original highlight"],
						prose: "Original prose.",
						model: "original-model",
					},
					fiscalDecisions: [],
					budgetDiscussions: [],
				});
			}).pipe(Effect.provide(context.layers)),
		);
		await context.db
			.update(schema.summaries)
			.set({
				sourceKinds: ["documents", "transcript"],
				sourceFingerprint: computeSourceFingerprint(["stale"]),
			})
			.where(eq(schema.summaries.meetingId, meeting.id))
			.run();
		return meeting;
	}

	it("rebuilds only the requested body's meetings, not another body's combined summary", async () => {
		const context = await setup({ documents: [MINUTES] });
		await combine(context);
		await context.db
			.insert(schema.governingBodies)
			.values({ name: "County Board", slug: "county-board", type: "county" })
			.run();
		const other = await storeCombinedMeeting(
			context,
			"county-board",
			"2025-05-27",
		);
		const otherSummary = () =>
			context.db
				.select()
				.from(schema.summaries)
				.where(eq(schema.summaries.meetingId, other.id))
				.all();
		const otherBefore = await otherSummary();
		context.calls.length = 0;

		const outcomes = await regenerateAll(context.layers);

		expect(outcomes.map((o) => o.meetingId)).toEqual([context.meeting.id]);
		expect(context.calls.map((c) => c.meetingContext)).toEqual([
			"Town Council, 2025-05-27",
		]);
		expect(await otherSummary()).toEqual(otherBefore);
	});

	it("carries on to the next meeting after one fails, leaving only the failed one's summary in place", async () => {
		const context = await setup({
			documents: [MINUTES],
			summarizeError: new Error("quota exceeded"),
			summarizeErrorFor: "2025-05-27",
		});
		await context.db
			.update(schema.summaries)
			.set({ sourceKinds: ["documents", "transcript"] })
			.where(eq(schema.summaries.meetingId, context.meeting.id))
			.run();
		const later = await storeCombinedMeeting(
			context,
			"town-council",
			"2025-06-09",
		);
		const summaryOf = (meetingId: number) =>
			context.db
				.select()
				.from(schema.summaries)
				.where(eq(schema.summaries.meetingId, meetingId))
				.all();
		const failedBefore = await summaryOf(context.meeting.id);

		const outcomes = await regenerateAll(context.layers);

		expect(outcomes).toEqual([
			{
				meetingId: context.meeting.id,
				date: "2025-05-27",
				outcome: "failed",
				message: "quota exceeded",
			},
			{ meetingId: later.id, date: "2025-06-09", outcome: "regenerated" },
		]);
		expect(await summaryOf(context.meeting.id)).toEqual(failedBefore);
		expect(await summaryOf(later.id)).toMatchObject([
			{ model: "regenerating-model" },
		]);
	});
});

describe("incompleteRegeneration", () => {
	const outcome = (o: "regenerated" | "skipped" | "failed") => ({
		meetingId: 1,
		date: "2025-05-27",
		outcome: o,
	});

	it("is null when every meeting was rebuilt", () => {
		expect(
			incompleteRegeneration([outcome("regenerated"), outcome("regenerated")]),
		).toBeNull();
	});

	it("flags a run that matched no meeting", () => {
		expect(incompleteRegeneration([])).toMatch(/No meeting/);
	});

	it("flags a skipped meeting", () => {
		expect(
			incompleteRegeneration([outcome("regenerated"), outcome("skipped")]),
		).toMatch(/0 meeting\(s\) failed and 1 were skipped/);
	});

	it("flags a failed meeting", () => {
		expect(incompleteRegeneration([outcome("failed")])).toMatch(
			/1 meeting\(s\) failed and 0 were skipped/,
		);
	});
});
