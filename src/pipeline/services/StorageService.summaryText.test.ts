import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { publicationOf } from "#/pipeline/checks/test-outcomes.ts";
import { createMigratedTestDb } from "#/pipeline/test-db.ts";
import { StorageService, StorageServiceLive } from "./StorageService.ts";

const PAVING = {
	title: "Paving bid",
	description: "Accepted the low bid",
	amount: 215215.1,
	originalAmount: "$215,215.10",
	budgetCategory: "roads",
	status: "approved" as const,
	voteRecord: { yea: 4, nay: 1, abstain: 0 },
	vendor: "E & B Paving",
	ordinanceNumber: "2025-12",
	confidence: 0.9,
	isRecurring: false,
};

const DISAGREEMENT = {
	topic: "Paving bid",
	documentsSay: "$215,215.10",
	transcriptSays: "$244,215.10",
};

const HELD_TEXT = {
	highlights: ["Council approves paving bid"],
	prose: "The council approved the paving bid for",
};

const NEW_TEXT = {
	highlights: ["Council accepts the low paving bid"],
	prose: "The council accepted the low paving bid.",
};

/** A meeting whose summary is held, with a ledger, a budget discussion and a disagreement. */
async function heldMeeting() {
	const db = await createMigratedTestDb();
	await db
		.insert(schema.governingBodies)
		.values({ name: "Town Council", slug: "town-council", type: "town" })
		.run();
	const layer = StorageServiceLive(db);
	const run = <A, E>(effect: Effect.Effect<A, E, StorageService>) =>
		Effect.runPromise(effect.pipe(Effect.provide(layer)));

	const meeting = await run(
		Effect.gen(function* () {
			const storage = yield* StorageService;
			const stored = yield* storage.storeMeeting({
				bodySlug: "town-council",
				date: "2025-05-27",
				meetingType: "regular",
				documents: [
					{
						sourceUrl: "https://example.com/minutes",
						rawText: "Minutes: accepted the paving bid of $215,215.10.",
						documentType: "minutes",
						extractionMethod: "ocr",
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
				budgetDiscussions: [
					{ topic: "Next year's paving", estimatedAmount: 300000, notes: "x" },
				],
				sourceKinds: ["documents"],
				sourceFingerprint: "fingerprint",
				sourceDisagreements: [DISAGREEMENT],
			});
			return stored;
		}),
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

	return { db, meeting, run, rows };
}

describe("getStoredLedger", () => {
	it("returns the meeting's stored fiscal decisions, with the confidence as stored", async () => {
		const { meeting, run } = await heldMeeting();

		const ledger = await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.getStoredLedger(meeting.id);
			}),
		);

		// The meeting's one document was OCR, so its decision is stored at 0.75 of 0.9.
		expect(ledger).toEqual([{ ...PAVING, confidence: 0.9 * 0.75 }]);
	});

	it("returns an empty ledger for a meeting with no fiscal decisions", async () => {
		const { run } = await heldMeeting();

		const ledger = await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.getStoredLedger(9999);
			}),
		);

		expect(ledger).toEqual([]);
	});
});

describe("replaceSummaryText", () => {
	it("swaps the text and publication, adds the run's rounds, and leaves the ledger, budget discussions and disagreements byte for byte", async () => {
		const { meeting, run, rows } = await heldMeeting();
		const before = await rows();
		expect(before.summary?.status).toBe("held");

		await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.replaceSummaryText({
					meetingId: meeting.id,
					...NEW_TEXT,
					publication: publicationOf(NEW_TEXT, "recheck-run"),
				});
			}),
		);

		const after = await rows();
		expect(after.fiscalDecisions).toEqual(before.fiscalDecisions);
		expect(after.budgetDiscussions).toEqual(before.budgetDiscussions);
		expect(after.summary).toMatchObject({
			highlights: NEW_TEXT.highlights,
			prose: NEW_TEXT.prose,
			status: "published",
			heldReason: null,
			sourceDisagreements: [DISAGREEMENT],
			sourceKinds: before.summary?.sourceKinds,
			sourceFingerprint: before.summary?.sourceFingerprint,
			model: before.summary?.model,
		});
		expect(after.rounds.map((round) => round.runId)).toEqual([
			"first-run",
			"recheck-run",
		]);
	});

	it("clears the release date and note of a released summary, which described the text it replaces", async () => {
		const { meeting, run, rows } = await heldMeeting();
		await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.releaseSummary({
					meetingId: meeting.id,
					note: "Read the held draft; it is fine.",
					edited: null,
				});
			}),
		);
		expect((await rows()).summary?.releaseNote).not.toBeNull();

		await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.replaceSummaryText({
					meetingId: meeting.id,
					...NEW_TEXT,
					publication: publicationOf(NEW_TEXT, "recheck-run"),
				});
			}),
		);

		expect((await rows()).summary).toMatchObject({
			releasedAt: null,
			releaseNote: null,
		});
	});

	it("fails and stores no rounds when the meeting has no summary", async () => {
		const { db, meeting, run, rows } = await heldMeeting();
		await db
			.delete(schema.summaries)
			.where(eq(schema.summaries.meetingId, meeting.id))
			.run();
		const before = await rows();

		const error = await run(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				yield* storage.replaceSummaryText({
					meetingId: meeting.id,
					...NEW_TEXT,
					publication: publicationOf(NEW_TEXT, "recheck-run"),
				});
			}).pipe(Effect.flip),
		);

		expect(error._tag).toBe("DatabaseError");
		expect((await rows()).rounds).toEqual(before.rounds);
	});
});
