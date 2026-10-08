import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type SummarizationInput,
	type SummarizationOutput,
	SummarizationService,
	SummarizationServiceLive,
	verifyAmounts,
} from "./SummarizationService.ts";

const SOURCE_TEXT = `
The Town Council approved a motion to allocate $50,000 for road repairs
on Sale Street. Council member Smith moved to approve the $12,500 contract
with ABC Paving for sidewalk improvements. The motion passed 4-1.
`;

describe("SummarizationService", () => {
	describe("verifyAmounts", () => {
		it("keeps full confidence when amounts appear in source text", () => {
			const decisions = [
				{
					title: "Road Repairs",
					description: "Sale Street road repairs",
					amount: 50000,
					originalAmount: "$50,000",
					confidence: 0.95,
				},
				{
					title: "Sidewalk Contract",
					description: "ABC Paving sidewalk improvements",
					amount: 12500,
					originalAmount: "$12,500",
					confidence: 0.9,
				},
			];

			const verified = verifyAmounts(decisions, SOURCE_TEXT);

			expect(verified[0].confidence).toBe(0.95);
			expect(verified[1].confidence).toBe(0.9);
		});

		it("downgrades confidence when amount is not in source text", () => {
			const decisions = [
				{
					title: "Phantom Expense",
					description: "This was never approved",
					amount: 99999,
					originalAmount: "$99,999",
					confidence: 0.8,
				},
			];

			const verified = verifyAmounts(decisions, SOURCE_TEXT);

			expect(verified[0].confidence).toBeCloseTo(0.32, 5);
		});
	});

	describe("SummarizationServiceLive", () => {
		it("summarizes meeting text and verifies extracted amounts", async () => {
			const stubOutput = {
				highlights: [
					"Approved $50,000 for Sale Street road repairs",
					"Approved $12,500 ABC Paving sidewalk contract",
				],
				prose: "The council approved road and sidewalk work totaling $62,500.",
				fiscalDecisions: [
					{
						title: "Road Repairs",
						description: "Sale Street road repairs",
						amount: 50000,
						originalAmount: "$50,000",
						status: "approved" as const,
						confidence: 0.95,
						isRecurring: false,
					},
					{
						title: "Sidewalk Contract",
						description: "ABC Paving sidewalk improvements",
						amount: 12500,
						originalAmount: "$12,500",
						status: "approved" as const,
						confidence: 0.9,
						isRecurring: false,
					},
				],
				budgetDiscussions: [],
				sourceDisagreements: [],
			};

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sources: [{ kind: "documents", text: SOURCE_TEXT }],
					meetingContext: "Town Council, March 23, 2026",
				});
			}).pipe(
				Effect.provide(
					SummarizationServiceLive({
						model: "gemini-2.5-flash",
						generateFn: async () => stubOutput,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.model).toBe("gemini-2.5-flash");
			expect(result.highlights).toHaveLength(2);
			expect(result.prose).toContain("$62,500");
			expect(result.fiscalDecisions).toHaveLength(2);
			expect(result.fiscalDecisions[0].confidence).toBe(0.95);
			expect(result.fiscalDecisions[1].confidence).toBe(0.9);
			expect(result.sourceDisagreements).toEqual([]);
		});

		it("downgrades confidence for amounts not found in source text", async () => {
			const stubOutput = {
				highlights: ["Phantom decision"],
				prose: "A decision that wasn't really in the source.",
				fiscalDecisions: [
					{
						title: "Phantom Expense",
						description: "This was never in the minutes",
						amount: 99999,
						originalAmount: "$99,999",
						status: "approved" as const,
						confidence: 0.8,
						isRecurring: false,
					},
				],
				budgetDiscussions: [],
				sourceDisagreements: [],
			};

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sources: [{ kind: "documents", text: SOURCE_TEXT }],
					meetingContext: "Town Council, March 23, 2026",
				});
			}).pipe(
				Effect.provide(
					SummarizationServiceLive({
						model: "gemini-2.5-flash",
						generateFn: async () => stubOutput,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.fiscalDecisions[0].confidence).toBeCloseTo(0.32, 5);
		});

		it("returns LlmError when the underlying model call throws", async () => {
			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sources: [{ kind: "documents", text: SOURCE_TEXT }],
					meetingContext: "Town Council, March 23, 2026",
				});
			}).pipe(
				Effect.provide(
					SummarizationServiceLive({
						model: "gemini-2.5-flash",
						generateFn: async () => {
							throw new Error("API quota exceeded");
						},
					}),
				),
			);

			const error = await Effect.runPromise(program.pipe(Effect.flip));
			expect(error._tag).toBe("LlmError");
			expect(error.model).toBe("gemini-2.5-flash");
			expect(error.message).toContain("API quota exceeded");
		});

		it("passes the meeting context to the generateFn", async () => {
			const calls: SummarizationInput[] = [];

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sources: [{ kind: "documents", text: "test source" }],
					meetingContext: "Plan Commission, April 1, 2026",
				});
			}).pipe(
				Effect.provide(
					SummarizationServiceLive({
						model: "gemini-2.5-flash",
						generateFn: async (args) => {
							calls.push(args);
							return {
								highlights: [],
								prose: "",
								fiscalDecisions: [],
								budgetDiscussions: [],
								sourceDisagreements: [],
							};
						},
					}),
				),
			);

			await Effect.runPromise(program);

			expect(calls).toHaveLength(1);
			expect(calls[0].sources).toEqual([
				{ kind: "documents", text: "test source" },
			]);
			expect(calls[0].meetingContext).toBe("Plan Commission, April 1, 2026");
		});
	});

	describe("labelled sources", () => {
		const PAVING_DISAGREEMENT = {
			topic: "Paving bid",
			documentsSay: "$215,215.10",
			transcriptSays: "$244,215.10",
		};

		const NAME_DISAGREEMENT = {
			topic: "Town Marshal's name",
			documentsSay: "Jimmie Durnil",
			transcriptSays: "Jimmy Gurnell",
		};

		function pavingOutput(
			originalAmount: string,
			sourceDisagreements: SummarizationOutput["sourceDisagreements"] = [
				{ ...PAVING_DISAGREEMENT, kind: "amount" },
			],
		): SummarizationOutput {
			return {
				highlights: ["Accepted the paving bid"],
				prose: "The council accepted a paving bid.",
				fiscalDecisions: [
					{
						title: "Paving bid",
						description: "Accepted the low bid for paving",
						amount: 215215.1,
						originalAmount,
						status: "approved",
						confidence: 0.9,
						isRecurring: false,
					},
				],
				budgetDiscussions: [],
				sourceDisagreements,
			};
		}

		function summarizeWith(
			output: SummarizationOutput,
			sources: SummarizationInput["sources"],
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* SummarizationService;
					return yield* service.summarize({
						sources,
						meetingContext: "Town Council, May 27, 2025",
					});
				}).pipe(
					Effect.provide(
						SummarizationServiceLive({
							model: "gemini-2.5-flash",
							generateFn: async () => output,
						}),
					),
				),
			);
		}

		const DOCUMENTS = {
			kind: "documents" as const,
			text: "Motion to accept the paving bid of $215,215.10 passed 5-0.",
		};
		const TRANSCRIPT = {
			kind: "transcript" as const,
			text: "the paving bid came in at $244,215.10 so I move we accept it",
		};

		it("returns the disagreements the model reports when both a documents and a transcript source are passed", async () => {
			const result = await summarizeWith(pavingOutput("$215,215.10"), [
				DOCUMENTS,
				TRANSCRIPT,
			]);

			expect(result.sourceDisagreements).toEqual([PAVING_DISAGREEMENT]);
		});

		it("drops a disagreement the model classifies as a name, and keeps the others", async () => {
			const result = await summarizeWith(
				pavingOutput("$215,215.10", [
					{ ...NAME_DISAGREEMENT, kind: "name" },
					{ ...PAVING_DISAGREEMENT, kind: "amount" },
				]),
				[DOCUMENTS, TRANSCRIPT],
			);

			expect(result.sourceDisagreements).toEqual([PAVING_DISAGREEMENT]);
		});

		it("returns no disagreements for a single kind of source, whatever the model reports", async () => {
			const documentsOnly = await summarizeWith(pavingOutput("$215,215.10"), [
				DOCUMENTS,
			]);
			const transcriptOnly = await summarizeWith(pavingOutput("$244,215.10"), [
				TRANSCRIPT,
			]);

			expect(documentsOnly.sourceDisagreements).toEqual([]);
			expect(transcriptOnly.sourceDisagreements).toEqual([]);
		});

		it("checks amounts against the documents text only when a documents source is present", async () => {
			const fromDocuments = await summarizeWith(pavingOutput("$215,215.10"), [
				DOCUMENTS,
				TRANSCRIPT,
			]);
			const fromTranscript = await summarizeWith(pavingOutput("$244,215.10"), [
				DOCUMENTS,
				TRANSCRIPT,
			]);

			expect(fromDocuments.fiscalDecisions[0].confidence).toBe(0.9);
			expect(fromTranscript.fiscalDecisions[0].confidence).toBeCloseTo(0.36, 5);
		});

		it("checks amounts against the transcript text when no documents source is present", async () => {
			const result = await summarizeWith(pavingOutput("$244,215.10"), [
				TRANSCRIPT,
			]);

			expect(result.fiscalDecisions[0].confidence).toBe(0.9);
		});

		it("checks amounts against every documents source", async () => {
			const result = await summarizeWith(pavingOutput("$215,215.10"), [
				{ kind: "documents", text: "Agenda: paving bids." },
				DOCUMENTS,
			]);

			expect(result.fiscalDecisions[0].confidence).toBe(0.9);
		});
	});
});
