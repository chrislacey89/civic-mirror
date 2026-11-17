import { eq } from "drizzle-orm";
import { Effect, Layer, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { listRecentMeetingsQuery } from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";
import { checkDraft } from "#/pipeline/checks/prePublish.ts";
import { publicationOf } from "#/pipeline/checks/test-outcomes.ts";
import type {
	PrePublishOutcome,
	WrittenDraft,
} from "#/pipeline/checks/types.ts";
import type { RecheckEntry } from "#/pipeline/recheckPreview.ts";
import {
	decodeRecheckPreview,
	encodeRecheckPreview,
} from "#/pipeline/recheckPreview.ts";
import {
	applyRecheckEntry,
	describeRecheck,
	previewMeetingRecheck,
} from "#/pipeline/rewrite.ts";
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
	let writeCalls = 0;
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
				writeCalls++;
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

	const preview = () =>
		Effect.runPromise(
			previewMeetingRecheck({
				meetingId: meeting.id,
				meetingContext: "Town Council, 2025-05-27",
				glossary: undefined,
				officials: [],
			}).pipe(Effect.provide(layers)),
		);

	const apply = (entry: RecheckEntry) =>
		Effect.runPromise(applyRecheckEntry(entry).pipe(Effect.provide(layers)));

	/** A preview saved to a file, read back, and applied: what --confirm --from does. */
	const recheck = async () => {
		const entry = await preview();
		const [saved] = decodeRecheckPreview(encodeRecheckPreview([entry]));
		if (!saved) throw new Error("the saved preview holds no entry");
		await apply(saved);
		return entry;
	};

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
		preview,
		apply,
		recheck,
		rows,
		ledgerCalls: () => ledgerCalls,
		writeCalls: () => writeCalls,
		writtenFrom,
	};
}

describe("recheck preview and apply", () => {
	it("when a saved preview is applied, stores its text and rounds under its run id exactly and makes no second writing call", async () => {
		const { recheck, rows, writeCalls } = await setup();

		const previewed = await recheck();

		const after = await rows();
		expect(writeCalls()).toBe(1);
		expect(after.summary).toMatchObject({
			highlights: previewed.outcome.best.highlights,
			prose: previewed.outcome.best.prose,
			status: "published",
			heldReason: null,
		});
		const stored = after.rounds.filter((r) => r.runId === previewed.runId);
		expect(stored.map((r) => r.prose)).toEqual(
			previewed.outcome.rounds.map((r) => r.draft.prose),
		);
	});

	it("when run with confirm, leaves fiscal_decisions and budget_discussions byte for byte and never calls the ledger generator", async () => {
		const { recheck, rows, ledgerCalls, writtenFrom } = await setup();
		const before = await rows();

		const result = await recheck();

		const after = await rows();
		expect(result.outcome.kind).toBe("publish");
		expect(ledgerCalls()).toBe(0);
		expect(writtenFrom).toHaveLength(1);
		expect(writtenFrom[0]?.map((d) => d.title)).toEqual([PAVING.title]);
		expect(after.fiscalDecisions).toEqual(before.fiscalDecisions);
		expect(after.budgetDiscussions).toEqual(before.budgetDiscussions);
		expect(after.summary?.prose).toBe(WHOLE.prose);
	});

	it("a preview returns the outcome under a new run id and writes nothing", async () => {
		const { preview, rows } = await setup();
		const before = await rows();

		const result = await preview();

		expect(result.outcome.kind).toBe("publish");
		expect(result.runId).not.toBe("first-run");
		expect(result.outcome.best.highlights).toEqual(WHOLE.highlights);
		expect(await rows()).toEqual(before);
	});

	it("when a held meeting rechecks to publish, stores it published and it reappears in the meeting list", async () => {
		const { db, recheck, rows } = await setup();
		expect((await rows()).summary?.status).toBe("held");
		expect(await listRecentMeetingsQuery(db, "town-council")).toEqual([]);

		await recheck();

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

		const result = await recheck();

		const after = await rows();
		expect(result.outcome.kind).toBe("held");
		expect(after.summary).toMatchObject({
			status: "held",
			heldReason: "gate-failed",
			prose: "The council accepted the paving bid of",
		});
		expect(new Set(after.rounds.map((round) => round.runId)).size).toBe(2);
	});

	it("if a preview file's best draft was edited so it no longer matches its round, refuses to read it", async () => {
		const { preview } = await setup();
		const file = JSON.parse(encodeRecheckPreview([await preview()]));
		file.entries[0].outcome.best.prose = "Jane Roe opposed the paving bid.";

		expect(() => decodeRecheckPreview(JSON.stringify(file))).toThrow(
			/best draft is not round 0's/,
		);
	});

	it("if a preview file has no best round, refuses to read it", async () => {
		const { preview } = await setup();
		const file = JSON.parse(encodeRecheckPreview([await preview()]));
		file.entries[0].outcome.bestRound = null;
		file.entries[0].outcome.best.prose = "Jane Roe opposed the paving bid.";

		expect(() => decodeRecheckPreview(JSON.stringify(file))).toThrow(
			/Not a recheck preview file/,
		);
	});

	it("if a preview file has no rounds, refuses to read it", async () => {
		const { preview } = await setup();
		const file = JSON.parse(encodeRecheckPreview([await preview()]));
		file.entries[0].outcome.bestRound = null;
		file.entries[0].outcome.rounds = [];

		expect(() => decodeRecheckPreview(JSON.stringify(file))).toThrow(
			/Not a recheck preview file/,
		);
	});

	it("if a preview file marks a draft to publish whose best round fails a gate, refuses to read it", async () => {
		const { preview } = await setup();
		const file = JSON.parse(encodeRecheckPreview([await preview()]));
		const { bestRound, rounds } = file.entries[0].outcome;
		rounds[bestRound].gateFailures = 1;

		expect(() => decodeRecheckPreview(JSON.stringify(file))).toThrow(
			/fails a gate/,
		);
	});

	it("if a file is not a recheck preview, refuses to read it", () => {
		expect(() =>
			decodeRecheckPreview(JSON.stringify({ version: 1, entries: [{}] })),
		).toThrow(/Not a recheck preview file/);
	});

	it("if the same saved preview is applied twice, refuses the second time and leaves the summary and rounds as the first apply stored them", async () => {
		const { preview, apply, rows } = await setup();
		const entry = await preview();
		const [saved] = decodeRecheckPreview(encodeRecheckPreview([entry]));
		if (!saved) throw new Error("the saved preview holds no entry");
		await apply(saved);
		const afterFirst = await rows();

		const error = await apply(saved).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeDefined();
		expect(await rows()).toEqual(afterFirst);
	});

	it("if the writing call fails, fails and leaves the stored summary unchanged", async () => {
		const { recheck, rows } = await setup(async () => {
			throw new Error("503 Service Unavailable");
		});
		const before = await rows();

		const error = await recheck().then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(String(error)).toContain("503 Service Unavailable");
		expect(await rows()).toEqual(before);
	});
});

describe("describeRecheck", () => {
	const checked = (draft: WrittenDraft): PrePublishOutcome =>
		checkDraft({
			draft,
			context: {
				input: {
					sources: [{ kind: "documents", text: MINUTES }],
					meetingContext: "",
				},
				ledger: [PAVING],
				officials: [],
			},
		});

	it("prints the outcome kind, no gate failures and the new headline for a draft that publishes", () => {
		expect(describeRecheck(checked(WHOLE))).toEqual([
			"  outcome:       publish",
			"  gate failures: -",
			`  headline:      ${WHOLE.highlights[0]}`,
		]);
	});

	it("prints each failing gate with its evidence for a held draft", () => {
		const lines = describeRecheck(
			checked({ ...WHOLE, prose: "The council accepted the paving bid of" }),
		);

		expect(lines[0]).toBe("  outcome:       held (gate-failed)");
		expect(lines[1]).toMatch(/^ {2}gate failures: TRUNC: /);
		expect(lines[2]).toBe(`  headline:      ${WHOLE.highlights[0]}`);
	});

	it("prints the same gate evidence for a held outcome read back from its preview file", () => {
		const outcome = checked({
			...WHOLE,
			prose: "The council accepted the paving bid of",
		});
		const [saved] = decodeRecheckPreview(
			encodeRecheckPreview([{ meetingId: 1, runId: "run", outcome }]),
		);

		expect(saved && describeRecheck(saved.outcome)).toEqual(
			describeRecheck(outcome),
		);
		expect(describeRecheck(outcome)[1]).toMatch(/TRUNC: /);
	});

	it("prints gate ids only and withholds the headline when A5 fails, so a resident's name is never printed", () => {
		const outcome: PrePublishOutcome = {
			kind: "held",
			reason: "gate-failed",
			best: { highlights: ["Jane Roe speaks against paving"], prose: "x." },
			gateFails: ["A5", "TRUNC"],
			rounds: [],
		};

		const lines = describeRecheck(outcome);

		expect(lines).toEqual([
			"  outcome:       held (gate-failed)",
			"  gate failures: A5, TRUNC",
			"  headline:      (withheld: A5 fails)",
		]);
		expect(lines.join("\n")).not.toContain("Jane Roe");
	});
});
