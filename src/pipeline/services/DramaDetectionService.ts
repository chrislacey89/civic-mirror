import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import {
	DRAMA_CATEGORIES,
	DRAMA_LEVELS,
	mapSumToLevel,
} from "#/lib/drama-levels.ts";
import { LlmError } from "#/pipeline/errors.ts";

/**
 * Per-category score schema. The Gemini structured-output API rejects
 * numeric enums (`enum: [0,1,2,3]` → "TYPE_STRING expected") even though
 * regular JSON Schema permits them, so we constrain the score with
 * `int().min(0).max(3)` instead of a literal union and rely on the
 * system prompt to instruct the model on the 0–3 anchor scale.
 * Evidence quotes are capped at 2 to keep prompt-iteration noise low.
 */
const categoryScoreSchema = z.object({
	score: z.number().int().min(0).max(3),
	evidence_quotes: z.array(z.string()).max(2),
});

const dramaAssessmentSchema = z.object({
	category_scores: z.object({
		procedural_breakdown: categoryScoreSchema,
		question_looping: categoryScoreSchema,
		defensive_hedging: categoryScoreSchema,
		timeline_pressure: categoryScoreSchema,
		improvised_workarounds: categoryScoreSchema,
		visible_dissent: categoryScoreSchema,
		post_hoc_corrections: categoryScoreSchema,
	}),
	level: z.enum(DRAMA_LEVELS),
	confidence: z.number().min(0).max(1),
	headline: z.string().max(200),
	narrative: z.string(),
});

type CategoryScore = z.infer<typeof categoryScoreSchema>;
type DramaAssessmentOutput = z.infer<typeof dramaAssessmentSchema>;

type DramaAssessmentResult = DramaAssessmentOutput & {
	model: string;
	promptVersion: string;
};

/**
 * Case- and whitespace-tolerant containment check. The LLM's quote may
 * differ from the transcript in punctuation density or whitespace runs;
 * what we care about is the word sequence.
 */
function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Two-pass verification per category. Drops any quote that doesn't appear
 * verbatim in the source. If the category was scored ≥1 but no quotes
 * survive verification, the category is downgraded to 0 (we'd rather miss
 * drama than invent it).
 */
function verifyEvidenceQuotes(
	category: CategoryScore,
	sourceText: string,
): CategoryScore {
	const haystack = normalize(sourceText);
	const verifiedQuotes = category.evidence_quotes.filter((quote) =>
		haystack.includes(normalize(quote)),
	);
	if (category.score >= 1 && verifiedQuotes.length === 0) {
		return { score: 0, evidence_quotes: [] };
	}
	return { ...category, evidence_quotes: verifiedQuotes };
}

function sumCategoryScores(
	scores: DramaAssessmentOutput["category_scores"],
): number {
	let total = 0;
	for (const cat of DRAMA_CATEGORIES) {
		total += scores[cat].score;
	}
	return total;
}

/**
 * The mechanical sum-to-tier mapping is the source of truth. If the LLM
 * emits a `level` that disagrees with `mapSumToLevel(sum(scores))`, the
 * computed level wins and the override is logged so prompt drift is
 * visible during iteration.
 */
function recomputeLevelFromScores(
	assessment: DramaAssessmentOutput,
): DramaAssessmentOutput {
	const sum = sumCategoryScores(assessment.category_scores);
	const computed = mapSumToLevel(sum);
	if (computed === assessment.level) return assessment;
	console.warn(
		`[drama] level override: LLM emitted "${assessment.level}", ` +
			`mapSumToLevel(${sum}) = "${computed}"`,
	);
	return { ...assessment, level: computed };
}

interface DramaDetectionServiceInterface {
	detect(
		input: DramaDetectionInput,
	): Effect.Effect<DramaAssessmentResult, LlmError>;
}

class DramaDetectionService extends Context.Tag("DramaDetectionService")<
	DramaDetectionService,
	DramaDetectionServiceInterface
>() {}

type DramaDetectionInput = {
	sourceText: string;
	meetingContext: string;
};

type DramaDetectionGenerateFn = (
	input: DramaDetectionInput,
) => Promise<DramaAssessmentOutput>;

type DramaDetectionServiceConfig = {
	model: string;
	promptVersion: string;
	generateFn: DramaDetectionGenerateFn;
};

function DramaDetectionServiceLive(
	config: DramaDetectionServiceConfig,
): Layer.Layer<DramaDetectionService> {
	return Layer.succeed(DramaDetectionService, {
		detect: (input) =>
			Effect.tryPromise({
				try: async () => {
					const raw = await config.generateFn(input);
					const verifiedScores = { ...raw.category_scores };
					for (const cat of DRAMA_CATEGORIES) {
						verifiedScores[cat] = verifyEvidenceQuotes(
							raw.category_scores[cat],
							input.sourceText,
						);
					}
					const reconciled = recomputeLevelFromScores({
						...raw,
						category_scores: verifiedScores,
					});
					return {
						...reconciled,
						model: config.model,
						promptVersion: config.promptVersion,
					};
				},
				catch: (error) =>
					new LlmError({
						model: config.model,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

export {
	DramaDetectionService,
	DramaDetectionServiceLive,
	dramaAssessmentSchema,
	recomputeLevelFromScores,
	sumCategoryScores,
	verifyEvidenceQuotes,
};
export type {
	CategoryScore,
	DramaAssessmentOutput,
	DramaAssessmentResult,
	DramaDetectionGenerateFn,
	DramaDetectionInput,
	DramaDetectionServiceConfig,
};
