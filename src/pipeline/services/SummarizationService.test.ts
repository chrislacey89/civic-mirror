import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
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
			};

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sourceText: SOURCE_TEXT,
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
			};

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sourceText: SOURCE_TEXT,
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
					sourceText: SOURCE_TEXT,
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
			const calls: Array<{ sourceText: string; meetingContext: string }> = [];

			const program = Effect.gen(function* () {
				const service = yield* SummarizationService;
				return yield* service.summarize({
					sourceText: "test source",
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
							};
						},
					}),
				),
			);

			await Effect.runPromise(program);

			expect(calls).toHaveLength(1);
			expect(calls[0].sourceText).toBe("test source");
			expect(calls[0].meetingContext).toBe("Plan Commission, April 1, 2026");
		});
	});
});
