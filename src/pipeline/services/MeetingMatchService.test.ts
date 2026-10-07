import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type MatchableSummary,
	type MatchDecideFn,
	MeetingMatchService,
	MeetingMatchServiceLive,
	SAME_MEETING_QUESTION,
} from "./MeetingMatchService.ts";

type RecordedPair = {
	transcriptDate: string;
	documentsDate: string;
	sameMeeting: boolean;
	/** Gemini's probability for this pair, recorded in the prototype run. */
	recordedProbability: number;
	transcriptSummary: MatchableSummary;
	documentsSummary: MatchableSummary;
};

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__", "same-meeting");
const RECORDED_PAIRS: RecordedPair[] = readdirSync(FIXTURE_DIR)
	.filter((file) => file.endsWith(".json"))
	.map((file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")));

const summary = (
	overrides: Partial<MatchableSummary> = {},
): MatchableSummary => ({
	highlights: [],
	prose: "",
	fiscalDecisions: [],
	...overrides,
});

const decides =
	(probabilitySameMeeting: number): MatchDecideFn =>
	async () => ({ probabilitySameMeeting });

function check(
	decideFn: MatchDecideFn,
	input: {
		transcriptSummary: MatchableSummary;
		documentsSummary: MatchableSummary;
	},
) {
	return Effect.gen(function* () {
		const service = yield* MeetingMatchService;
		return yield* service.check(input);
	}).pipe(Effect.provide(MeetingMatchServiceLive({ decideFn })));
}

const PAVING_TRANSCRIPT = summary({
	highlights: ["Approved the paving bid of $215,215.10"],
});
const PAVING_DOCUMENTS = summary({
	prose: "The council accepted a paving bid for $215,215.10.",
});
const NO_IDENTIFIERS_A = summary({
	prose: "The council heard public comment.",
});
const NO_IDENTIFIERS_B = summary({ prose: "Department heads gave reports." });

describe("MeetingMatchService", () => {
	describe("decision table", () => {
		it("returns match when the probability is at least 0.5 and an identifier is shared", async () => {
			const result = await Effect.runPromise(
				check(decides(0.5), {
					transcriptSummary: PAVING_TRANSCRIPT,
					documentsSummary: PAVING_DOCUMENTS,
				}),
			);

			expect(result).toEqual({
				outcome: "match",
				probability: 0.5,
				sharedIdentifiers: 1,
			});
		});

		it("holds as signals-disagree when the probability is 0.99 and neither summary has an identifier", async () => {
			const result = await Effect.runPromise(
				check(decides(0.99), {
					transcriptSummary: NO_IDENTIFIERS_A,
					documentsSummary: NO_IDENTIFIERS_B,
				}),
			);

			expect(result).toEqual({
				outcome: "hold",
				reason: "signals-disagree",
				probability: 0.99,
				sharedIdentifiers: 0,
			});
		});

		it("holds as signals-disagree when the probability is below 0.5 and an identifier is shared", async () => {
			const result = await Effect.runPromise(
				check(decides(0.49), {
					transcriptSummary: PAVING_TRANSCRIPT,
					documentsSummary: PAVING_DOCUMENTS,
				}),
			);

			expect(result).toEqual({
				outcome: "hold",
				reason: "signals-disagree",
				probability: 0.49,
				sharedIdentifiers: 1,
			});
		});

		it("holds as check-failed when the probability is below 0.5 and no identifier is shared", async () => {
			const result = await Effect.runPromise(
				check(decides(0.1), {
					transcriptSummary: PAVING_TRANSCRIPT,
					documentsSummary: NO_IDENTIFIERS_B,
				}),
			);

			expect(result).toEqual({
				outcome: "hold",
				reason: "check-failed",
				probability: 0.1,
				sharedIdentifiers: 0,
			});
		});
	});

	describe("shared identifiers", () => {
		const sharedBetween = async (a: MatchableSummary, b: MatchableSummary) =>
			(
				await Effect.runPromise(
					check(decides(0.9), { transcriptSummary: a, documentsSummary: b }),
				)
			).sharedIdentifiers;

		it("counts a dollar amount once whether or not it has trailing whitespace", async () => {
			const withAmount = (originalAmount: string) =>
				summary({ fiscalDecisions: [{ title: "Paving bid", originalAmount }] });

			expect(
				await sharedBetween(
					withAmount("$215,215.10"),
					withAmount("$215,215.10 "),
				),
			).toBe(1);
		});

		it("counts an ordinance number once across case and a 'no.' prefix", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "The council adopted Ordinance 2025-13." }),
					summary({ highlights: ["Passed ordinance no. 2025-13"] }),
				),
			).toBe(1);
		});

		it("counts a resolution numbered sequence-first, as in 'Resolution 18-2025'", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "Resolution 18-2025 appropriated more funds." }),
					summary({ highlights: ["Passed resolution 18-2025"] }),
				),
			).toBe(1);
		});

		it("counts an ordinance number carried only in a fiscal decision's ordinanceNumber", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "The council adopted Resolution 2025-08." }),
					summary({
						fiscalDecisions: [
							{
								title: "Wheel tax",
								originalAmount: "$25",
								ordinanceNumber: "2025-08",
							},
						],
					}),
				),
			).toBe(1);
		});

		it("does not count different amounts or numbers as shared", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "Ordinance 2025-13 set a fee of $215,215.10." }),
					summary({ prose: "Ordinance 2025-14 set a fee of $244,215.10." }),
				),
			).toBe(0);
		});

		it("does not count a $0 amount as shared", async () => {
			const zeroDecision = (title: string) =>
				summary({
					fiscalDecisions: [{ title, originalAmount: "$0" }],
				});

			expect(
				await sharedBetween(
					zeroDecision("Sidewalk repair"),
					zeroDecision("Park lease"),
				),
			).toBe(0);
		});

		it("does not count '$2 million' and '$2' as the same amount", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "The council approved a $2 million bond." }),
					summary({ prose: "The council approved a $2 fee." }),
				),
			).toBe(0);
		});

		it.each([
			{ a: "$2M", b: "$2" },
			{ a: "$2.4M", b: "$2.4" },
			{ a: "$50K", b: "$50" },
			{ a: "$2 mil", b: "$2" },
			{ a: "$2-million", b: "$2" },
			{ a: "$2 millions", b: "$2" },
			{ a: "$2 hundred thousand", b: "$2" },
		])("does not count '$a' and '$b' as the same amount", async ({ a, b }) => {
			expect(
				await sharedBetween(
					summary({ prose: `The council approved ${a} for the project.` }),
					summary({ prose: `The council approved ${b} for the project.` }),
				),
			).toBe(0);
		});

		it("still counts an amount followed by an ordinary word", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "A $250 rental fee and $5 per vehicle." }),
					summary({
						highlights: ["Set $250 rental fee", "Charged $5 per vehicle"],
						prose: "Repairs of $1,000 for repairs.",
					}),
				),
			).toBe(2);
		});

		it("counts '$2 million' once across case and spacing", async () => {
			expect(
				await sharedBetween(
					summary({ prose: "The council approved a $2 million bond." }),
					summary({ highlights: ["Bond of $2  Million approved"] }),
				),
			).toBe(1);
		});
	});

	describe("text passed to the decision function", () => {
		it("contains no month-and-day date from either summary", async () => {
			const seen: { a: string; b: string }[] = [];
			const recording: MatchDecideFn = async ({ a, b }) => {
				seen.push({ a, b });
				return { probabilitySameMeeting: 0.9 };
			};

			await Effect.runPromise(
				check(recording, {
					transcriptSummary: summary({
						highlights: ["Minutes of May 27, 2025 approved"],
						prose:
							"At the Sept. 22 meeting the council set a hearing for June 9th. The council may 5 times a year waive the fee.",
						fiscalDecisions: [
							{ title: "Bid opened August 11", originalAmount: "$1,000" },
						],
					}),
					documentsSummary: summary({
						prose:
							"The regular meeting of DECEMBER 8, 2025 was called to order. The 6/9/2025 claims were paid.",
					}),
				}),
			);

			expect(seen).toHaveLength(1);
			const { a, b } = seen[0];
			for (const date of [
				"May 27",
				"2025",
				"Sept. 22",
				"June 9",
				"August 11",
			]) {
				expect(a).not.toContain(date);
			}
			for (const date of ["DECEMBER 8", "2025", "6/9"]) {
				expect(b).not.toContain(date);
			}
			// The modal verb is not a month, and amounts survive.
			expect(a).toContain("may 5 times a year");
			expect(a).toContain("$1,000");
		});

		it("carries the locked question, with the transcript as A and the documents as B", async () => {
			const seen: Parameters<MatchDecideFn>[0][] = [];
			const recording: MatchDecideFn = async (input) => {
				seen.push(input);
				return { probabilitySameMeeting: 0.9 };
			};

			await Effect.runPromise(
				check(recording, {
					transcriptSummary: PAVING_TRANSCRIPT,
					documentsSummary: PAVING_DOCUMENTS,
				}),
			);

			expect(seen[0].question).toBe(SAME_MEETING_QUESTION);
			expect(seen[0].question).toContain(
				"Do most of the specific items of business in A also appear in B?",
			);
			expect(seen[0].a).toContain("Approved the paving bid");
			expect(seen[0].b).toContain("The council accepted a paving bid");
		});
	});

	describe("decision call failures", () => {
		const failure = (decideFn: MatchDecideFn) =>
			Effect.runPromise(
				check(decideFn, {
					transcriptSummary: PAVING_TRANSCRIPT,
					documentsSummary: PAVING_DOCUMENTS,
				}).pipe(Effect.flip),
			);

		it("fails with MeetingMatchError when the decision call throws", async () => {
			const error = await failure(async () => {
				throw new Error("quota exceeded");
			});

			expect(error._tag).toBe("MeetingMatchError");
			expect(error.message).toContain("quota exceeded");
		});

		it.each([
			Number.NaN,
			-0.1,
			1.01,
			95,
		])("fails with MeetingMatchError when the probability is %s", async (probability) => {
			const error = await failure(decides(probability));

			expect(error._tag).toBe("MeetingMatchError");
		});
	});

	describe("recorded prototype pairs", () => {
		const replay = (pair: RecordedPair) =>
			Effect.runPromise(
				check(decides(pair.recordedProbability), {
					transcriptSummary: pair.transcriptSummary,
					documentsSummary: pair.documentsSummary,
				}),
			);
		const truePairs = RECORDED_PAIRS.filter((pair) => pair.sameMeeting);
		const neighbouringPairs = RECORDED_PAIRS.filter(
			(pair) => !pair.sameMeeting,
		);

		it("has at least six true pairs and six neighbouring pairs", () => {
			expect(truePairs.length).toBeGreaterThanOrEqual(6);
			expect(neighbouringPairs.length).toBeGreaterThanOrEqual(6);
		});

		it.each(
			truePairs,
		)("matches the $transcriptDate video with its own minutes", async (pair) => {
			expect((await replay(pair)).outcome).toBe("match");
		});

		it.each(
			neighbouringPairs,
		)("holds the $transcriptDate video against the $documentsDate minutes", async (pair) => {
			expect((await replay(pair)).outcome).toBe("hold");
		});

		it("holds 2025-05-27 against 2025-06-09 as signals-disagree: tabled ordinances reappear at the next meeting", async () => {
			const pair = neighbouringPairs.find(
				(p) =>
					p.transcriptDate === "2025-05-27" && p.documentsDate === "2025-06-09",
			);
			if (!pair) throw new Error("fixture missing");

			const result = await replay(pair);

			expect(result.reason).toBe("signals-disagree");
			expect(result.sharedIdentifiers).toBeGreaterThanOrEqual(1);
		});
	});
});
