import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { detachDocumentAndRegenerate } from "#/pipeline/detach.ts";
import { LlmError } from "#/pipeline/errors.ts";
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

const AUGUST_URL = "https://example.com/doc/august-25";
const JULY_URL = "https://example.com/doc/july-28";
const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";

const AUGUST_MINUTES: MeetingInput["documents"][number] = {
	sourceUrl: AUGUST_URL,
	rawText: "August 25, 2025. The council adopted the wheel tax ordinance.",
	documentType: "minutes",
	extractionMethod: "text-layer",
};
const JULY_MINUTES: MeetingInput["documents"][number] = {
	sourceUrl: JULY_URL,
	rawText: "July 28, 2025. The council awarded the bridge bid of $541,363.00.",
	documentType: "minutes",
	extractionMethod: "text-layer",
};

const REGENERATED: SummarizationResult = {
	highlights: ["Adopted the wheel tax"],
	prose: "The council adopted the wheel tax ordinance.",
	fiscalDecisions: [
		{
			title: "Wheel tax",
			description: "Adopted the ordinance",
			amount: 89000,
			originalAmount: "$89,000",
			status: "approved",
			confidence: 0.9,
			isRecurring: false,
		},
	],
	budgetDiscussions: [],
	sourceDisagreements: [],
	model: "regenerating-model",
};

/**
 * A database holding one meeting whose summary was built from every source
 * given, and the layers `detachDocumentAndRegenerate` runs on.
 */
async function setup(options: {
	documents: MeetingInput["documents"];
	transcript?: boolean;
	/** False stores the summary with no fingerprint, as `storeMeeting` alone does. */
	fingerprinted?: boolean;
}) {
	const db = await createMigratedTestDb();
	await db
		.insert(schema.governingBodies)
		.values({ name: "Town Council", slug: "town-council", type: "town" })
		.run();

	const calls: SummarizationInput[] = [];
	/** Set `failing` to make the next summarize calls fail. */
	const summarizer = { failing: false };
	const summarization = Layer.succeed(SummarizationService, {
		summarize: (input) =>
			Effect.suspend(() => {
				calls.push(input);
				return summarizer.failing
					? Effect.fail(
							new LlmError({ model: "regenerating-model", message: "down" }),
						)
					: Effect.succeed(REGENERATED);
			}),
	});
	const layers = Layer.mergeAll(StorageServiceLive(db), summarization);

	const heldUrls = [
		...options.documents.map((d) => d.sourceUrl),
		...(options.transcript ? [VIDEO_URL] : []),
	];
	const meeting = await Effect.runPromise(
		Effect.gen(function* () {
			const storage = yield* StorageService;
			const stored = yield* storage.storeMeeting({
				bodySlug: "town-council",
				date: "2025-08-25",
				meetingType: "regular",
				documents: options.documents,
				summary: {
					highlights: ["Awarded the bridge bid"],
					prose:
						"From the July 28 records, the council awarded the bridge bid.",
					model: "original-model",
					...(options.fingerprinted === false
						? {}
						: {
								sourceKinds: ["documents"],
								sourceFingerprint: computeSourceFingerprint(heldUrls),
							}),
				},
				fiscalDecisions: [
					{
						title: "Bridge bid",
						description: "Awarded to the low bidder",
						amount: 541363,
						originalAmount: "$541,363.00",
						status: "approved" as const,
						confidence: 0.9,
						isRecurring: false,
					},
				],
				budgetDiscussions: [],
			});
			if (options.transcript) {
				yield* storage.storeTranscript({
					meetingId: stored.id,
					source: "captions",
					rawText: "We are adopting the wheel tax tonight.",
					sourceUrl: VIDEO_URL,
				});
			}
			return stored;
		}).pipe(Effect.provide(layers)),
	);

	const detach = (sourceUrl: string) =>
		Effect.runPromise(
			detachDocumentAndRegenerate({
				meetingId: meeting.id,
				sourceUrl,
				meetingContext: "Town Council, 2025-08-25",
				glossary: undefined,
			}).pipe(Effect.provide(layers)),
		);

	const rows = async () => ({
		documentUrls: (
			await db
				.select()
				.from(schema.documents)
				.where(eq(schema.documents.meetingId, meeting.id))
				.all()
		).map((d) => d.sourceUrl),
		summaries: await db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, meeting.id))
			.all(),
		fiscalDecisionTitles: (
			await db
				.select()
				.from(schema.fiscalDecisions)
				.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
				.all()
		).map((d) => d.title),
	});

	return { calls, summarizer, detach, rows };
}

describe("detachDocumentAndRegenerate", () => {
	it("removes the document and rebuilds the summary from the sources that remain", async () => {
		const { calls, detach, rows } = await setup({
			documents: [AUGUST_MINUTES, JULY_MINUTES],
		});

		const result = await detach(JULY_URL);

		expect(result).toEqual({ outcome: "detached", regenerated: true });
		expect(calls).toEqual([
			{
				sources: [{ kind: "documents", text: AUGUST_MINUTES.rawText }],
				meetingContext: "Town Council, 2025-08-25",
			},
		]);
		const after = await rows();
		expect(after.documentUrls).toEqual([AUGUST_URL]);
		expect(after.summaries).toHaveLength(1);
		expect(after.summaries[0]).toMatchObject({
			prose: "The council adopted the wheel tax ordinance.",
			sourceKinds: ["documents"],
			sourceFingerprint: computeSourceFingerprint([AUGUST_URL]),
		});
		expect(after.fiscalDecisionTitles).toEqual(["Wheel tax"]);
	});

	it("rebuilds a summary that was stored without a fingerprint", async () => {
		const { calls, detach, rows } = await setup({
			documents: [AUGUST_MINUTES, JULY_MINUTES],
			fingerprinted: false,
		});

		const result = await detach(JULY_URL);

		expect(result).toEqual({ outcome: "detached", regenerated: true });
		expect(calls).toHaveLength(1);
		const after = await rows();
		expect(after.summaries[0].sourceFingerprint).toBe(
			computeSourceFingerprint([AUGUST_URL]),
		);
		expect(after.fiscalDecisionTitles).toEqual(["Wheel tax"]);
	});

	it("rebuilds from the remaining document and the transcript when the meeting has a video", async () => {
		const { calls, detach, rows } = await setup({
			documents: [AUGUST_MINUTES, JULY_MINUTES],
			transcript: true,
		});

		await detach(JULY_URL);

		expect(calls[0].sources).toEqual([
			{ kind: "documents", text: AUGUST_MINUTES.rawText },
			{ kind: "transcript", text: "We are adopting the wheel tax tonight." },
		]);
		const after = await rows();
		expect(after.summaries[0]).toMatchObject({
			sourceKinds: ["documents", "transcript"],
			sourceFingerprint: computeSourceFingerprint([AUGUST_URL, VIDEO_URL]),
		});
	});

	it("refuses to remove the last source a meeting can be summarized from", async () => {
		const { calls, detach, rows } = await setup({
			documents: [JULY_MINUTES],
		});

		const result = await detach(JULY_URL);

		expect(result).toEqual({ outcome: "last-source" });
		expect(calls).toEqual([]);
		const after = await rows();
		expect(after.documentUrls).toEqual([JULY_URL]);
		expect(after.fiscalDecisionTitles).toEqual(["Bridge bid"]);
	});

	it("changes nothing for a URL the meeting does not hold", async () => {
		const { calls, detach, rows } = await setup({
			documents: [AUGUST_MINUTES, JULY_MINUTES],
		});

		const result = await detach("https://example.com/doc/never-attached");

		expect(result).toEqual({ outcome: "not-held", regenerated: false });
		expect(calls).toEqual([]);
		const after = await rows();
		expect(after.documentUrls).toEqual([AUGUST_URL, JULY_URL]);
		expect(after.fiscalDecisionTitles).toEqual(["Bridge bid"]);
	});

	it("finishes the rebuild on a second call when the first one's summarize call failed", async () => {
		const { summarizer, detach, rows } = await setup({
			documents: [AUGUST_MINUTES, JULY_MINUTES],
		});
		summarizer.failing = true;
		await expect(detach(JULY_URL)).rejects.toThrow();
		expect((await rows()).fiscalDecisionTitles).toEqual(["Bridge bid"]);

		summarizer.failing = false;
		const result = await detach(JULY_URL);

		expect(result).toEqual({ outcome: "not-held", regenerated: true });
		const after = await rows();
		expect(after.documentUrls).toEqual([AUGUST_URL]);
		expect(after.fiscalDecisionTitles).toEqual(["Wheel tax"]);
	});
});
