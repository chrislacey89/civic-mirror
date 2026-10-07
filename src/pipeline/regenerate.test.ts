import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { LlmError } from "#/pipeline/errors.ts";
import { regenerateMeetingSummary } from "#/pipeline/regenerate.ts";
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
				return options.summarizeError
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

	const regenerate = () =>
		Effect.runPromise(
			regenerateMeetingSummary({
				meetingId: meeting.id,
				meetingContext: "Town Council, 2025-05-27",
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
				yield* storage.stampSummaryFingerprint({
					meetingId: meeting.id,
					sourceFingerprint: computeSourceFingerprint([AGENDA_URL]),
				});
			}).pipe(Effect.provide(layers)),
		);

		const stamped = await regenerate();

		expect(stamped).toEqual({ regenerated: true });
		expect(calls).toHaveLength(1);
	});
});
