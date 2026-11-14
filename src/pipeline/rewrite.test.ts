import { eq } from "drizzle-orm";
import { Effect, Layer, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { listRecentMeetingsQuery } from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";
import { publicationOf } from "#/pipeline/checks/test-outcomes.ts";
import type { WrittenDraft } from "#/pipeline/checks/types.ts";
import { recheckMeetingSummary } from "#/pipeline/rewrite.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import {
	type SummarizationOutput,
	SummarizationServiceLive,
	type SummarizationWriteFn,
} from "#/pipeline/services/SummarizationService.ts";
import { createMigratedTestDb } from "#/pipeline/test-db.ts";

const MINUTES = "Minutes: accepted the paving bid of $215,215.10.";

const PAVING = {
	title: "Paving bid",
	description: "Accepted the low bid",
	amount: 215215.1,
	originalAmount: "$215,215.10",
	status: "approved" as const,
	confidence: 0.9,
	isRecurring: false,
};

const HELD_TEXT = {
	highlights: ["Council approves paving bid"],
	prose: "The council approved the paving bid for",
};

const WHOLE: WrittenDraft = {
	highlights: ["Council accepts $215,215.10 paving bid"],
	prose: "The council accepted the paving bid of $215,215.10.",
	finishReason: "stop",
	usage: null,
};

/**
 * A database holding one meeting whose summary is held, and a recheck of it
 * run with the real summarizer over a stub writer and a counting generator.
 */
async function setup(writeFn: SummarizationWriteFn = async () => WHOLE) {
	const db = await createMigratedTestDb();
	await db
		.insert(schema.governingBodies)
		.values({ name: "Town Council", slug: "town-council", type: "town" })
		.run();

	let ledgerCalls = 0;
	const writtenFrom: SummarizationOutput["fiscalDecisions"][] = [];
	const layers = Layer.mergeAll(
		StorageServiceLive(db),
		SummarizationServiceLive({
			model: "rewriting-model",
			revisionRetry: Schedule.recurs(0),
			generateFn: async () => {
				ledgerCalls++;
				throw new Error("the ledger call must not run");
			},
			writeFn: async (input, ledger, revision) => {
				writtenFrom.push(ledger);
				return writeFn(input, ledger, revision);
			},
		}),
	);

	const meeting = await Effect.runPromise(
		Effect.gen(function* () {
			const storage = yield* StorageService;
			const stored = yield* storage.storeMeeting({
				bodySlug: "town-council",
				date: "2025-05-27",
				meetingType: "regular",
				documents: [
					{
						sourceUrl: "https://example.com/minutes",
						rawText: MINUTES,
						documentType: "minutes",
						extractionMethod: "text-layer",
					},
				],
			});
			yield* storage.replaceMeetingSummary({
				meetingId: stored.id,
				summary: {
					...HELD_TEXT,
					model: "original-model",
					publication: publicationOf(HELD_TEXT, "first-run"),
				},
				fiscalDecisions: [PAVING],
				budgetDiscussions: [{ topic: "Next year's paving" }],
				sourceKinds: ["documents"],
				sourceFingerprint: "fingerprint",
				sourceDisagreements: [],
			});
			return stored;
		}).pipe(Effect.provide(layers)),
	);

	const recheck = (confirm: boolean) =>
		Effect.runPromise(
			recheckMeetingSummary({
				meetingId: meeting.id,
				meetingContext: "Town Council, 2025-05-27",
				glossary: undefined,
				officials: [],
				confirm,
			}).pipe(Effect.provide(layers)),
		);

	const rows = async () => ({
		summary: await db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, meeting.id))
			.get(),
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
		rounds: await db
			.select()
			.from(schema.summaryRounds)
			.where(eq(schema.summaryRounds.meetingId, meeting.id))
			.all(),
	});

	return {
		db,
		meeting,
		recheck,
		rows,
		ledgerCalls: () => ledgerCalls,
		writtenFrom,
	};
}

describe("recheckMeetingSummary", () => {
	it("when run with confirm, leaves fiscal_decisions and budget_discussions byte for byte and never calls the ledger generator", async () => {
		const { recheck, rows, ledgerCalls, writtenFrom } = await setup();
		const before = await rows();

		const result = await recheck(true);

		const after = await rows();
		expect(result.outcome.kind).toBe("publish");
		expect(ledgerCalls()).toBe(0);
		expect(writtenFrom).toHaveLength(1);
		expect(writtenFrom[0]?.map((d) => d.title)).toEqual([PAVING.title]);
		expect(after.fiscalDecisions).toEqual(before.fiscalDecisions);
		expect(after.budgetDiscussions).toEqual(before.budgetDiscussions);
		expect(after.summary?.prose).toBe(WHOLE.prose);
	});

	it("if run without confirm, returns the outcome and writes nothing", async () => {
		const { recheck, rows } = await setup();
		const before = await rows();

		const result = await recheck(false);

		expect(result).toMatchObject({
			written: false,
			outcome: { kind: "publish" },
		});
		expect(result.outcome.best.highlights).toEqual(WHOLE.highlights);
		expect(await rows()).toEqual(before);
	});

	it("when a held meeting rechecks to publish, stores it published and it reappears in the meeting list", async () => {
		const { db, recheck, rows } = await setup();
		expect((await rows()).summary?.status).toBe("held");
		expect(await listRecentMeetingsQuery(db, "town-council")).toEqual([]);

		await recheck(true);

		expect((await rows()).summary).toMatchObject({
			status: "published",
			heldReason: null,
		});
		const listed = await listRecentMeetingsQuery(db, "town-council");
		expect(listed.map((meeting) => meeting.date)).toEqual(["2025-05-27"]);
	});

	it("stores a recheck that is still held as held, with the new run's rounds", async () => {
		const { recheck, rows } = await setup(async () => ({
			...WHOLE,
			prose: "The council accepted the paving bid of",
		}));

		const result = await recheck(true);

		const after = await rows();
		expect(result.outcome.kind).toBe("held");
		expect(after.summary).toMatchObject({
			status: "held",
			heldReason: "gate-failed",
			prose: "The council accepted the paving bid of",
		});
		expect(new Set(after.rounds.map((round) => round.runId)).size).toBe(2);
	});

	it("if the writing call fails, fails and leaves the stored summary unchanged", async () => {
		const { recheck, rows } = await setup(async () => {
			throw new Error("503 Service Unavailable");
		});
		const before = await rows();

		const error = await recheck(true).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(String(error)).toContain("503 Service Unavailable");
		expect(await rows()).toEqual(before);
	});
});
