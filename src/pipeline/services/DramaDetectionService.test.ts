import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	DramaDetectionService,
	DramaDetectionServiceLive,
	dramaAssessmentSchema,
	recomputeLevelFromScores,
	verifyEvidenceQuotes,
} from "./DramaDetectionService.ts";

const SOURCE_TEXT = `
Council member Smith said, "I cannot support this without seeing the
job descriptions first." The board chair replied that the descriptions
would be drafted next week. Smith pressed: "We are voting on positions
that have not been formally approved." The motion passed 4-1.
`.trim();

const ZERO_CATEGORY_SCORES = {
	procedural_breakdown: { score: 0 as const, evidence_quotes: [] },
	question_looping: { score: 0 as const, evidence_quotes: [] },
	unanswered_questions: { score: 0 as const, evidence_quotes: [] },
	undecided_time: { score: 0 as const, evidence_quotes: [] },
	improvised_workarounds: { score: 0 as const, evidence_quotes: [] },
	repeat_deferrals: { score: 0 as const, evidence_quotes: [] },
	post_hoc_corrections: { score: 0 as const, evidence_quotes: [] },
};

describe("verifyEvidenceQuotes", () => {
	it("verifies a quote that spans an inline timestamp marker", () => {
		const verified = verifyEvidenceQuotes(
			{ score: 1, evidence_quotes: ["we will table this until next month"] },
			"[00:00] Chair: we will table this [00:30] until next month",
		);
		expect(verified.score).toBe(1);
		expect(verified.evidence_quotes).toHaveLength(1);
	});

	it("does not verify a quote made only of timestamp markers", () => {
		const verified = verifyEvidenceQuotes(
			{ score: 2, evidence_quotes: ["[00:00]", "[12:00] [32:00]"] },
			"[00:00] Chair: we will table this [00:30] until next month",
		);
		expect(verified.evidence_quotes).toEqual([]);
		expect(verified.score).toBe(0);
	});

	it("does not verify an empty or whitespace-only quote", () => {
		const verified = verifyEvidenceQuotes(
			{ score: 1, evidence_quotes: ["", "   "] },
			SOURCE_TEXT,
		);
		expect(verified.evidence_quotes).toEqual([]);
		expect(verified.score).toBe(0);
	});

	it("keeps quotes that appear verbatim in the source text", () => {
		const verified = verifyEvidenceQuotes(
			{
				score: 2,
				evidence_quotes: [
					"I cannot support this without seeing the job descriptions first.",
				],
			},
			SOURCE_TEXT,
		);

		expect(verified.score).toBe(2);
		expect(verified.evidence_quotes).toHaveLength(1);
	});

	it("matches case- and whitespace-insensitively", () => {
		const verified = verifyEvidenceQuotes(
			{
				score: 1,
				evidence_quotes: [
					"i  CANNOT support   this without seeing  the JOB descriptions first.",
				],
			},
			SOURCE_TEXT,
		);

		expect(verified.score).toBe(1);
		expect(verified.evidence_quotes).toHaveLength(1);
	});

	it("drops unverifiable quotes when score is mixed-verifiable", () => {
		const verified = verifyEvidenceQuotes(
			{
				score: 2,
				evidence_quotes: [
					"We are voting on positions that have not been formally approved.",
					"This quote is fabricated and not in the transcript.",
				],
			},
			SOURCE_TEXT,
		);

		expect(verified.score).toBe(2);
		expect(verified.evidence_quotes).toEqual([
			"We are voting on positions that have not been formally approved.",
		]);
	});

	it("downgrades score to 0 when all quotes for a non-zero score fail verification", () => {
		const verified = verifyEvidenceQuotes(
			{
				score: 3,
				evidence_quotes: ["This was never said.", "Neither was this."],
			},
			SOURCE_TEXT,
		);

		expect(verified.score).toBe(0);
		expect(verified.evidence_quotes).toEqual([]);
	});

	it("leaves score-zero categories at zero with no quotes", () => {
		const verified = verifyEvidenceQuotes(
			{ score: 0, evidence_quotes: [] },
			SOURCE_TEXT,
		);

		expect(verified.score).toBe(0);
		expect(verified.evidence_quotes).toEqual([]);
	});
});

describe("recomputeLevelFromScores", () => {
	it("preserves matching level when sum maps to the same tier", () => {
		const assessment = {
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				repeat_deferrals: { score: 3 as const, evidence_quotes: ["a"] },
				procedural_breakdown: { score: 3 as const, evidence_quotes: ["b"] },
			},
			level: "bumpy" as const, // 3+3 = 6 → bumpy
			confidence: 0.7,
			headline: "h",
			narrative: "n",
		};

		const result = recomputeLevelFromScores(assessment);

		expect(result.level).toBe("bumpy");
	});

	it("overrides LLM-emitted level when it disagrees with the sum", () => {
		const assessment = {
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				repeat_deferrals: { score: 3 as const, evidence_quotes: ["a"] },
			},
			level: "off-the-rails" as const, // sum=3 → routine
			confidence: 0.9,
			headline: "h",
			narrative: "n",
		};

		const result = recomputeLevelFromScores(assessment);

		expect(result.level).toBe("routine");
	});
});

describe("dramaAssessmentSchema", () => {
	it("rejects out-of-range scores", () => {
		const bad = {
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				repeat_deferrals: { score: 4, evidence_quotes: [] },
			},
			level: "routine",
			confidence: 0.5,
			headline: "h",
			narrative: "n",
		};

		expect(() => dramaAssessmentSchema.parse(bad)).toThrow();
	});

	it("rejects more than 2 evidence quotes per category", () => {
		const bad = {
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				repeat_deferrals: {
					score: 2,
					evidence_quotes: ["one", "two", "three"],
				},
			},
			level: "routine",
			confidence: 0.5,
			headline: "h",
			narrative: "n",
		};

		expect(() => dramaAssessmentSchema.parse(bad)).toThrow();
	});

	it("rejects headlines longer than 200 chars", () => {
		const bad = {
			category_scores: ZERO_CATEGORY_SCORES,
			level: "routine",
			confidence: 0.5,
			headline: "x".repeat(201),
			narrative: "n",
		};

		expect(() => dramaAssessmentSchema.parse(bad)).toThrow();
	});
});

describe("DramaDetectionServiceLive", () => {
	const STUB_OUTPUT = {
		category_scores: {
			...ZERO_CATEGORY_SCORES,
			repeat_deferrals: {
				score: 2 as const,
				evidence_quotes: [
					"We are voting on positions that have not been formally approved.",
				],
			},
		},
		level: "routine" as const,
		confidence: 0.6,
		headline: "Council split on undocumented positions",
		narrative: "Vote passed 4-1 amid procedural concerns.",
	};

	it("runs the verification pipeline and stamps model + promptVersion", async () => {
		const program = Effect.gen(function* () {
			const service = yield* DramaDetectionService;
			return yield* service.detect({
				sourceText: SOURCE_TEXT,
				meetingContext: "Town Council, March 23, 2026",
			});
		}).pipe(
			Effect.provide(
				DramaDetectionServiceLive({
					model: "gemini-2.5-flash",
					promptVersion: "v1",
					generateFn: async () => STUB_OUTPUT,
				}),
			),
		);

		const result = await Effect.runPromise(program);

		expect(result.model).toBe("gemini-2.5-flash");
		expect(result.promptVersion).toBe("v1");
		expect(result.category_scores.repeat_deferrals.score).toBe(2);
	});

	it("downgrades a category to 0 when all its quotes are fabricated", async () => {
		const stub = {
			...STUB_OUTPUT,
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				undecided_time: {
					score: 2 as const,
					evidence_quotes: ["never said", "also never said"],
				},
			},
		};

		const program = Effect.gen(function* () {
			const service = yield* DramaDetectionService;
			return yield* service.detect({
				sourceText: SOURCE_TEXT,
				meetingContext: "ctx",
			});
		}).pipe(
			Effect.provide(
				DramaDetectionServiceLive({
					model: "gemini-2.5-flash",
					promptVersion: "v1",
					generateFn: async () => stub,
				}),
			),
		);

		const result = await Effect.runPromise(program);

		expect(result.category_scores.undecided_time.score).toBe(0);
		expect(result.category_scores.undecided_time.evidence_quotes).toEqual([]);
	});

	it("overrides level to match the mechanical sum", async () => {
		// LLM emits "routine" but scores sum to 6 → should become "bumpy"
		const stub = {
			...STUB_OUTPUT,
			category_scores: {
				...ZERO_CATEGORY_SCORES,
				repeat_deferrals: {
					score: 3 as const,
					evidence_quotes: [
						"We are voting on positions that have not been formally approved.",
					],
				},
				procedural_breakdown: {
					score: 3 as const,
					evidence_quotes: [
						"I cannot support this without seeing the job descriptions first.",
					],
				},
			},
			level: "routine" as const,
		};

		const program = Effect.gen(function* () {
			const service = yield* DramaDetectionService;
			return yield* service.detect({
				sourceText: SOURCE_TEXT,
				meetingContext: "ctx",
			});
		}).pipe(
			Effect.provide(
				DramaDetectionServiceLive({
					model: "gemini-2.5-flash",
					promptVersion: "v1",
					generateFn: async () => stub,
				}),
			),
		);

		const result = await Effect.runPromise(program);

		expect(result.level).toBe("bumpy");
	});

	it("returns LlmError when generateFn throws", async () => {
		const program = Effect.gen(function* () {
			const service = yield* DramaDetectionService;
			return yield* service.detect({
				sourceText: SOURCE_TEXT,
				meetingContext: "ctx",
			});
		}).pipe(
			Effect.provide(
				DramaDetectionServiceLive({
					model: "gemini-2.5-flash",
					promptVersion: "v1",
					generateFn: async () => {
						throw new Error("API quota exceeded");
					},
				}),
			),
		);

		// runPromiseExit preserves the typed Exit so we can distinguish a typed
		// failure (Cause.Fail) from a defect (Cause.Die) — flip + runPromise
		// would conflate the two.
		const exit = await Effect.runPromiseExit(program);

		expect(Exit.isFailure(exit)).toBe(true);
		if (!Exit.isFailure(exit)) return;
		const failure = Cause.findErrorOption(exit.cause);
		expect(failure._tag).toBe("Some");
		if (failure._tag !== "Some") return;
		expect(failure.value._tag).toBe("LlmError");
		expect(failure.value.message).toContain("API quota exceeded");
	});
});
