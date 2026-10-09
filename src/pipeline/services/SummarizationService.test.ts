import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	figureIsIn,
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
	describe("figureIsIn", () => {
		it.each([
			["$750.00", "$75,000", false],
			["$5,000.00", "$500,000", false],
			["$5,000", "$50.00", false],
			["$1,000", "$10.00", false],
			["$750", "$7.50", false],
			["$500", "$5.00", false],
			["$12.50", "paid 12 to the clerk", false],
			["$215,215.10", "a total of 215,215 overall", false],
			["$5,000", "see $5,000.2025 budget", true],
			["$5,000", "$5,000. 2,000", true],
			["$5,000.00", "$5,000", true],
			["$5,000", "$5,000.00", true],
			["$5,000.00", "$50,000.00", false],
			["$500", "2,500", false],
			["$258,400.00", "not to exceed $258.400.00.", true],
			["$244,215.10", "low bid for $244,21510", true],
			["$244,215.10", "low bid for $244,215", false],
			["not stated", "the amount is not stated", true],
		])("%s in %j is %s", (amount, text, expected) => {
			expect(figureIsIn(amount, text)).toBe(expected);
		});
	});

	describe("figureIsIn, as a written dollar amount", () => {
		it.each([
			["$215.10", "E & B Paving for fpaa-215.10 and Milestone", false],
			["$277,571.80", "Milestone Paving for $277,571.80.", true],
			["$258,400.00", "not to exceed $258.400.00.", true],
			["$5,000", "a transfer of $ 5,000 from the fund", true],
			["$5,000", "5,000 square feet at $2.00", false],
			["$43,900.00", "in the amount of 43,900.00", false],
			["not stated", "the amount is not stated", true],
		])("%j in %j is %s", (amount, text, expected) => {
			expect(figureIsIn(amount, text, { asDollarAmount: true })).toBe(expected);
		});

		it("still finds a figure with no dollar sign when one is not asked for", () => {
			expect(figureIsIn("$215.10", "for fpaa-215.10 and")).toBe(true);
			expect(figureIsIn("$196,486.51", "the bid was 196,48651")).toBe(true);
		});
	});

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

	describe("verifyAmounts, against documents", () => {
		it("lowers confidence for a figure the documents hold only as a bare number", () => {
			const decision = {
				title: "Paving bid",
				description: "Low bid",
				amount: 215.1,
				originalAmount: "$215.10",
				confidence: 0.9,
			};

			const [bare] = verifyAmounts([decision], "Paving for fpaa-215.10 and", {
				asDollarAmount: true,
			});
			const [written] = verifyAmounts([decision], "Paving for $215.10 and", {
				asDollarAmount: true,
			});

			expect(bare.confidence).toBeCloseTo(0.36, 5);
			expect(written.confidence).toBe(0.9);
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

		it("logs each dropped name disagreement with its topic and both sides", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await summarizeWith(
					pavingOutput("$215,215.10", [
						{ ...NAME_DISAGREEMENT, kind: "name" },
						{ ...PAVING_DISAGREEMENT, kind: "amount" },
					]),
					[DOCUMENTS, TRANSCRIPT],
				);

				expect(warn).toHaveBeenCalledTimes(1);
				const message = String(warn.mock.calls[0][0]);
				expect(message).toContain("Town Marshal's name");
				expect(message).toContain("Jimmie Durnil");
				expect(message).toContain("Jimmy Gurnell");
			} finally {
				warn.mockRestore();
			}
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

			expect(fromDocuments.fiscalDecisions).toHaveLength(1);
			expect(fromDocuments.fiscalDecisions[0].confidence).toBe(0.9);
			expect(fromTranscript.fiscalDecisions).toHaveLength(1);
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

	describe("documents and a transcript together", () => {
		const MINUTES = {
			kind: "documents" as const,
			text: "Motion to approve Resolution 38-2025, a $43,900.00 crash team grant, carried 4-0.",
		};
		const CAPTIONS = {
			kind: "transcript" as const,
			text: "the grant is almost $44,000 all in favor and the truck is about $1,000,000",
		};

		const CRASH_GRANT = {
			title: "Resolution 38-2025 crash team grant",
			description: "Interlocal agreement for a crash investigation team",
			amount: 43900,
			originalAmount: "$43,900.00",
			status: "approved" as const,
			confidence: 0.9,
			isRecurring: false,
		};
		const FIRE_TRUCK = {
			title: "Fire truck order",
			description: "Authorized ordering a fire truck",
			amount: 1000000,
			originalAmount: "$1,000,000",
			status: "approved" as const,
			confidence: 0.9,
			isRecurring: false,
		};

		function output(
			fiscalDecisions: SummarizationOutput["fiscalDecisions"],
			prose: string,
		): SummarizationOutput {
			return {
				highlights: [],
				prose,
				fiscalDecisions,
				budgetDiscussions: [],
				sourceDisagreements: [],
			};
		}

		/** Answers a documents-alone call and an every-source call differently. */
		function summarizeTogether(answers: {
			fromDocuments: SummarizationOutput;
			fromEverySource: SummarizationOutput;
		}) {
			const calls: SummarizationInput[] = [];
			const result = Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* SummarizationService;
					return yield* service.summarize({
						sources: [MINUTES, CAPTIONS],
						meetingContext: "Town Council, November 24, 2025",
					});
				}).pipe(
					Effect.provide(
						SummarizationServiceLive({
							model: "gemini-2.5-flash",
							generateFn: async (input) => {
								calls.push(input);
								return input.sources.some(
									(source) => source.kind === "transcript",
								)
									? answers.fromEverySource
									: answers.fromDocuments;
							},
						}),
					),
				),
			);
			return { calls, result };
		}

		it("keeps a fiscal decision taken from the documents when the summary of every source leaves it out", async () => {
			const { result } = summarizeTogether({
				fromDocuments: output([CRASH_GRANT], "Minutes only."),
				fromEverySource: output([], "Minutes and discussion."),
			});

			const summary = await result;

			expect(summary.fiscalDecisions).toEqual([CRASH_GRANT]);
			expect(summary.prose).toBe("Minutes and discussion.");
		});

		it("adds a decision only the transcript records after the documents' own, at lowered confidence when the documents do not state its amount", async () => {
			const { result } = summarizeTogether({
				fromDocuments: output([CRASH_GRANT], "Minutes only."),
				fromEverySource: output([FIRE_TRUCK], "Minutes and discussion."),
			});

			const summary = await result;

			expect(summary.fiscalDecisions.map((decision) => decision.title)).toEqual(
				[CRASH_GRANT.title, FIRE_TRUCK.title],
			);
			expect(summary.fiscalDecisions[0].confidence).toBe(0.9);
			expect(summary.fiscalDecisions[1].confidence).toBeCloseTo(0.36, 5);
		});

		it("drops a transcript decision that repeats a recorded one by ordinance number under another title", async () => {
			const documents = output(
				[{ ...CRASH_GRANT, ordinanceNumber: "resolution  38-2025" }],
				"Minutes only.",
			);
			const repeated = summarizeTogether({
				fromDocuments: documents,
				fromEverySource: output(
					[
						{
							...CRASH_GRANT,
							title: "Crash team interlocal grant",
							ordinanceNumber: "Resolution 38-2025",
						},
					],
					"Minutes and discussion.",
				),
			});

			const summary = await repeated.result;

			expect(summary.fiscalDecisions).toEqual(documents.fiscalDecisions);
		});

		it("drops a transcript decision with the same title and amount as a recorded one", async () => {
			const { result } = summarizeTogether({
				fromDocuments: output([CRASH_GRANT], "Minutes only."),
				fromEverySource: output(
					[{ ...CRASH_GRANT, title: "  resolution 38-2025 CRASH team grant" }],
					"Minutes and discussion.",
				),
			});

			const summary = await result;

			expect(summary.fiscalDecisions).toEqual([CRASH_GRANT]);
		});

		it("keeps a transcript decision that shares 'not stated' and its status with a recorded one", async () => {
			const unstated = {
				...CRASH_GRANT,
				title: "Hire a clerk",
				amount: 0,
				originalAmount: "not stated",
			};
			const added = {
				...unstated,
				title: "Declare the old plow surplus",
				confidence: 0.8,
			};
			const { result } = summarizeTogether({
				fromDocuments: output([unstated], "Minutes only."),
				fromEverySource: output([added], "Minutes and discussion."),
			});

			const summary = await result;

			expect(summary.fiscalDecisions.map((decision) => decision.title)).toEqual(
				[unstated.title, added.title],
			);
		});

		it("keeps a transcript decision with the same stated amount as a recorded one but a different title and no ordinance", async () => {
			const { result } = summarizeTogether({
				fromDocuments: output([CRASH_GRANT], "Minutes only."),
				fromEverySource: output(
					[{ ...CRASH_GRANT, title: "Second grant, same sum" }],
					"Minutes and discussion.",
				),
			});

			const summary = await result;

			expect(summary.fiscalDecisions).toHaveLength(2);
		});

		it("tells the summary of every source which decisions the documents already gave", async () => {
			const { calls, result } = summarizeTogether({
				fromDocuments: output([CRASH_GRANT], "Minutes only."),
				fromEverySource: output([], "Minutes and discussion."),
			});

			await result;

			expect(calls).toHaveLength(2);
			expect(calls[0].sources).toEqual([MINUTES]);
			expect(calls[0].recordedDecisions).toBeUndefined();
			expect(calls[1].sources).toEqual([MINUTES, CAPTIONS]);
			expect(calls[1].recordedDecisions).toEqual([CRASH_GRANT]);
		});
	});
	describe("a figure the documents do not contain", () => {
		const PAVING = {
			title: "Paving bid award to E & B Paving",
			description: "Accepted the low bid for the paving grant match",
			status: "approved" as const,
			confidence: 0.9,
			isRecurring: false,
		};
		const REBUILT = {
			...PAVING,
			amount: 215215.1,
			originalAmount: "$215,215.10",
		};
		const SCANNED_MINUTES = {
			kind: "documents" as const,
			text: "two bids from E & B Paving for fpaa-215.10 and Milestone Paving for $277,571.80. Motion carries.",
		};
		const CAPTIONS = {
			kind: "transcript" as const,
			text: "we will be going with the low bid from EMB paving for $244,21510",
		};

		const DECIDED_TITLE =
			"Approval of bid for Community Crossing Grant Match to E & B Paving";

		function output(
			fiscalDecisions: SummarizationOutput["fiscalDecisions"],
			sourceDisagreements: SummarizationOutput["sourceDisagreements"] = [],
		): SummarizationOutput {
			return {
				highlights: [],
				prose: "Summary.",
				fiscalDecisions,
				budgetDiscussions: [],
				sourceDisagreements,
			};
		}

		function summarizeBoth(
			sources: SummarizationInput["sources"],
			answers: {
				fromDocuments: SummarizationOutput["fiscalDecisions"];
				fromEverySource: SummarizationOutput["fiscalDecisions"];
				disagreements?: SummarizationOutput["sourceDisagreements"];
			},
		) {
			const calls: SummarizationInput[] = [];
			const result = Effect.runPromise(
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
							generateFn: async (input) => {
								calls.push(input);
								return output(
									input.sources.some((source) => source.kind === "transcript")
										? answers.fromEverySource
										: answers.fromDocuments,
									input.sources.some((source) => source.kind === "transcript")
										? answers.disagreements
										: [],
								);
							},
						}),
					),
				),
			);
			return { calls, result };
		}

		it("takes the transcript's figure for a decision whose documents figure is not in the documents, and records that", async () => {
			const { calls, result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [REBUILT],
				fromEverySource: [
					{ ...PAVING, amount: 244215.1, originalAmount: "$244,215.10" },
				],
			});

			const summary = await result;

			expect(summary.fiscalDecisions).toHaveLength(1);
			expect(summary.fiscalDecisions[0].amount).toBe(244215.1);
			expect(summary.fiscalDecisions[0].originalAmount).toBe("$244,215.10");
			expect(summary.fiscalDecisions[0].confidence).toBeCloseTo(0.36, 5);
			expect(summary.sourceDisagreements).toEqual([
				{
					topic: PAVING.title,
					documentsSay:
						"No readable figure. The summary uses the video's figure.",
					transcriptSays: "$244,215.10",
				},
			]);
			expect(calls[1].recordedDecisions).toEqual([]);
			expect(calls[1].unreadFigures).toEqual([REBUILT]);
		});

		it("returns one disagreement for an unread figure when the model reports its own under another topic", async () => {
			const { result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [{ ...REBUILT, title: DECIDED_TITLE }],
				fromEverySource: [
					{
						...PAVING,
						title: DECIDED_TITLE,
						amount: 244215.1,
						originalAmount: "$244,215.10",
					},
				],
				disagreements: [
					{
						topic: "E & B Paving bid amount for Community Crossing Grant",
						documentsSay: "fpaa-215.10",
						transcriptSays: "$244,21510",
						kind: "amount",
					},
				],
			});

			const summary = await result;

			expect(summary.sourceDisagreements).toEqual([
				{
					topic: DECIDED_TITLE,
					documentsSay:
						"No readable figure. The summary uses the video's figure.",
					transcriptSays: "$244,215.10",
				},
			]);
		});

		it("keeps a reported disagreement about a different matter beside the one for an unread figure", async () => {
			const vote = {
				topic: "Vote on the paving bid",
				documentsSay: "5-0",
				transcriptSays: "4-1",
				kind: "vote" as const,
			};
			const otherAmount = {
				topic: "Milestone Paving bid",
				documentsSay: "$277,571.80",
				transcriptSays: "$277,000",
				kind: "amount" as const,
			};
			const { result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [REBUILT],
				fromEverySource: [
					{ ...PAVING, amount: 244215.1, originalAmount: "$244,215.10" },
				],
				disagreements: [vote, otherAmount],
			});

			const summary = await result;

			expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
				vote.topic,
				otherAmount.topic,
				PAVING.title,
			]);
		});

		describe("a reported disagreement that quotes the unread figure", () => {
			const RECORDED = {
				...PAVING,
				amount: 244215.1,
				originalAmount: "$244,215.10",
			};
			const UNREAD = { ...REBUILT, originalAmount: "$5,000" };
			const FIVE_THOUSAND = {
				...PAVING,
				amount: 5000,
				originalAmount: "$5,000",
			};

			function run(
				disagreement: SummarizationOutput["sourceDisagreements"][number],
			) {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const { result } = summarizeBoth(
					[
						{
							kind: "documents",
							text: "Bid from E & B Paving for fpaa-5x00.",
						},
						{ kind: "transcript", text: "the paving bid is $5,000 and 5-0" },
					],
					{
						fromDocuments: [UNREAD],
						fromEverySource: [FIVE_THOUSAND],
						disagreements: [disagreement],
					},
				);
				return { warn, result };
			}

			it("keeps a vote whose transcript side has the same digits as the figure", async () => {
				const { warn, result } = run({
					topic: "Vote on the paving bid award to E & B Paving",
					documentsSay: "4-1",
					transcriptSays: "$5 vote, 5-0",
					kind: "vote",
				});
				try {
					const summary = await result;
					expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
						"Vote on the paving bid award to E & B Paving",
						PAVING.title,
					]);
					expect(warn).not.toHaveBeenCalled();
				} finally {
					warn.mockRestore();
				}
			});

			it("keeps an amount about a different item even when it quotes the same figure", async () => {
				const { warn, result } = run({
					topic: "Parks department supplies",
					documentsSay: "$4,000",
					transcriptSays: "$5,000",
					kind: "amount",
				});
				try {
					const summary = await result;
					expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
						"Parks department supplies",
						PAVING.title,
					]);
					expect(warn).not.toHaveBeenCalled();
				} finally {
					warn.mockRestore();
				}
			});

			// The recorded title "Paving bid award to E & B Paving" has the words
			// of four or more letters "paving" and "award" ("bid", "to", "e", "b" are too short).
			it("keeps an amount quoting the same figure whose topic shares exactly one word with the title (paving)", async () => {
				const { warn, result } = run({
					topic: "Paving crew overtime",
					documentsSay: "$4,000",
					transcriptSays: "$5,000",
					kind: "amount",
				});
				try {
					const summary = await result;
					expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
						"Paving crew overtime",
						PAVING.title,
					]);
					expect(warn).not.toHaveBeenCalled();
				} finally {
					warn.mockRestore();
				}
			});

			it("drops an amount quoting the same figure whose topic shares exactly two words with the title (paving, award)", async () => {
				const { warn, result } = run({
					topic: "Paving award total",
					documentsSay: "$4,000",
					transcriptSays: "$5,000",
					kind: "amount",
				});
				try {
					const summary = await result;
					expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
						PAVING.title,
					]);
					expect(warn).toHaveBeenCalledTimes(1);
				} finally {
					warn.mockRestore();
				}
			});

			// Generic title words and bare numbers do not count toward the two
			// shared words, so these titles are compared on their other words.
			async function topicsKeptFor(title: string, reportedTopic: string) {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					const { result } = summarizeBoth(
						[
							{
								kind: "documents",
								text: "Bid from E & B Paving for fpaa-5x00.",
							},
							{ kind: "transcript", text: "the bid is $5,000 and 5-0" },
						],
						{
							fromDocuments: [{ ...UNREAD, title }],
							fromEverySource: [{ ...FIVE_THOUSAND, title }],
							disagreements: [
								{
									topic: reportedTopic,
									documentsSay: "$4,000",
									transcriptSays: "$5,000",
									kind: "amount",
								},
							],
						},
					);
					return (await result).sourceDisagreements.map((d) => d.topic);
				} finally {
					warn.mockRestore();
				}
			}

			it("keeps an amount for another item whose topic shares only generic title words with the title", async () => {
				const title =
					"Approval of resolution authorizing contract for street paving";
				const other =
					"Approval of resolution authorizing contract for police vehicles";
				expect(await topicsKeptFor(title, other)).toEqual([other, title]);
			});

			it("keeps an amount whose topic shares only one naming word with the title besides generic ones", async () => {
				const title =
					"Approval of resolution authorizing contract for street paving";
				const other = "Resolution authorizing contract for paving crew";
				expect(await topicsKeptFor(title, other)).toEqual([other, title]);
			});

			it("keeps an amount whose topic shares only a number and one word with the title", async () => {
				const title = "Ordinance 2025-12 authorizing transfer";
				const other = "Ordinance 2025-12 transfer";
				expect(await topicsKeptFor(title, other)).toEqual([other, title]);
			});

			it("drops an amount whose topic shares two naming words with the title among generic ones", async () => {
				const title =
					"Approval of resolution authorizing contract for street paving";
				const other = "Resolution for the street paving contract amount";
				expect(await topicsKeptFor(title, other)).toEqual([title]);
			});

			it("keeps an amount about the motion whose transcript side has no figure", async () => {
				const { warn, result } = run({
					topic: "E & B Paving bid award amount",
					documentsSay: "fpaa-5x00",
					transcriptSays: "a low bid",
					kind: "amount",
				});
				try {
					const summary = await result;
					expect(summary.sourceDisagreements).toHaveLength(2);
				} finally {
					warn.mockRestore();
				}
			});

			it("drops the model's second entry for the motion and logs it", async () => {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					const title =
						"Approval of bid for Community Crossing Grant Match to E & B Paving";
					const { result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
						fromDocuments: [{ ...REBUILT, title }],
						fromEverySource: [{ ...RECORDED, title }],
						disagreements: [
							{
								topic: "E & B Paving bid amount for Community Crossing Grant",
								documentsSay: "fpaa-215.10",
								transcriptSays: "$244,21510",
								kind: "amount",
							},
						],
					});

					const summary = await result;

					expect(summary.sourceDisagreements.map((d) => d.topic)).toEqual([
						title,
					]);
					expect(warn).toHaveBeenCalledTimes(1);
					const message = String(warn.mock.calls[0][0]);
					expect(message).toContain(
						"E & B Paving bid amount for Community Crossing Grant",
					);
					expect(message).toContain("fpaa-215.10");
					expect(message).toContain("$244,21510");
				} finally {
					warn.mockRestore();
				}
			});
		});

		it("does not let the documents govern a fragment of a figure the OCR garbled", async () => {
			const fragment = { ...PAVING, amount: 215.1, originalAmount: "$215.10" };
			const { calls, result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [fragment],
				fromEverySource: [
					{ ...PAVING, amount: 244215.1, originalAmount: "$244,21510" },
				],
			});

			const summary = await result;

			expect(calls[1].unreadFigures).toEqual([fragment]);
			expect(summary.fiscalDecisions.map((d) => d.amount)).toEqual([244215.1]);
			expect(summary.sourceDisagreements).toHaveLength(1);
		});

		it("stores no amount when the transcript's figure for that decision is not in the transcript either", async () => {
			const { result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [REBUILT],
				fromEverySource: [
					{ ...PAVING, amount: 215215.1, originalAmount: "$215,215.10" },
				],
			});

			const summary = await result;

			expect(summary.fiscalDecisions).toHaveLength(1);
			expect(summary.fiscalDecisions[0].title).toBe(PAVING.title);
			expect(summary.fiscalDecisions[0].amount).toBe(0);
			expect(summary.fiscalDecisions[0].originalAmount).toBe("not stated");
			expect(summary.sourceDisagreements).toEqual([]);
		});

		it("stores no amount when the every-source call does not return that decision", async () => {
			const { result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [REBUILT],
				fromEverySource: [],
			});

			const summary = await result;

			expect(summary.fiscalDecisions.map((d) => [d.title, d.amount])).toEqual([
				[PAVING.title, 0],
			]);
		});

		it("keeps a documents figure the scan wrote with a period for the comma, whatever the transcript says", async () => {
			const scada = {
				title: "SCADA system migration",
				description: "Not to exceed amount for the SCADA migration",
				amount: 258400,
				originalAmount: "$258,400.00",
				status: "approved" as const,
				confidence: 0.9,
				isRecurring: false,
			};
			const { calls, result } = summarizeBoth(
				[
					{ kind: "documents", text: "Total was not to exceed $258.400.00." },
					{ kind: "transcript", text: "not to exceed about $260,000" },
				],
				{
					fromDocuments: [scada],
					fromEverySource: [
						{ ...scada, amount: 260000, originalAmount: "$260,000" },
					],
				},
			);

			const summary = await result;

			expect(summary.fiscalDecisions).toEqual([scada]);
			expect(calls[1].recordedDecisions).toEqual([scada]);
			expect(calls[1].unreadFigures).toEqual([]);
		});

		it("leaves a decision with no stated amount alone", async () => {
			const agreement = {
				...PAVING,
				title: "Fire services agreement",
				amount: 0,
				originalAmount: "not stated",
			};
			const { calls, result } = summarizeBoth([SCANNED_MINUTES, CAPTIONS], {
				fromDocuments: [agreement],
				fromEverySource: [],
			});

			const summary = await result;

			expect(summary.fiscalDecisions.map((d) => d.originalAmount)).toEqual([
				"not stated",
			]);
			expect(calls[1].unreadFigures).toEqual([]);
		});
	});
});
