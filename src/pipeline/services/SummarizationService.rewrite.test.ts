import { Effect, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import type { WrittenDraft } from "#/pipeline/checks/types.ts";
import {
	type SummarizationOutput,
	SummarizationService,
	SummarizationServiceLive,
	type SummarizationWriteFn,
} from "./SummarizationService.ts";

const LEDGER: SummarizationOutput["fiscalDecisions"] = [
	{
		title: "Paving bid",
		description: "Accepted the low bid",
		amount: 50000,
		originalAmount: "$50,000",
		status: "approved",
		confidence: 0.9,
		isRecurring: false,
	},
];

const WHOLE: WrittenDraft = {
	highlights: ["Council approves paving bid"],
	prose: "The council approved the paving bid.",
	finishReason: "stop",
	usage: null,
};

const CUT: WrittenDraft = {
	...WHOLE,
	prose: "The council approved the paving bid for",
};

/** Rewrites one meeting's text, counting the ledger calls and the ledgers the writer saw. */
function rewriteWith(writeFn: SummarizationWriteFn, roundCap = 1) {
	let ledgerCalls = 0;
	const written: SummarizationOutput["fiscalDecisions"][] = [];
	const run = Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* SummarizationService;
			return yield* service.rewrite(
				{
					officials: [],
					sources: [
						{
							kind: "documents",
							text: "The council approved $50,000 for paving.",
						},
					],
					meetingContext: "Town Council, May 27, 2025",
				},
				LEDGER,
			);
		}).pipe(
			Effect.provide(
				SummarizationServiceLive({
					model: "gemini-2.5-flash",
					roundCap,
					revisionRetry: Schedule.recurs(0),
					writeFn: async (input, ledger, revision) => {
						written.push(ledger);
						return writeFn(input, ledger, revision);
					},
					generateFn: async () => {
						ledgerCalls++;
						throw new Error("the ledger call must not run");
					},
				}),
			),
		),
	);
	return { run, ledgerCalls: () => ledgerCalls, written };
}

describe("SummarizationService.rewrite", () => {
	it("writes from the ledger it is given and never calls the ledger generator", async () => {
		const { run, ledgerCalls, written } = rewriteWith(async () => WHOLE);

		const outcome = await run;

		expect(ledgerCalls()).toBe(0);
		expect(written).toEqual([LEDGER]);
		expect(outcome.kind).toBe("publish");
		expect(outcome.best).toMatchObject({
			highlights: WHOLE.highlights,
			prose: WHOLE.prose,
		});
	});

	it("revises a held draft from the same ledger without calling the ledger generator", async () => {
		let calls = 0;
		const { run, ledgerCalls, written } = rewriteWith(async () => {
			calls++;
			return calls === 1 ? CUT : WHOLE;
		}, 3);

		const outcome = await run;

		expect(ledgerCalls()).toBe(0);
		expect(written).toEqual([LEDGER, LEDGER]);
		expect(outcome.kind).toBe("publish");
		expect(outcome.rounds).toHaveLength(2);
	});

	it("fails, carrying the writer's message, when the first writing call fails", async () => {
		const { run } = rewriteWith(async () => {
			throw new Error("503 Service Unavailable");
		});

		const error = await run.then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(String(error)).toContain("503 Service Unavailable");
	});
});
