import { type GoogleGenerativeAIProviderOptions, google } from "@ai-sdk/google";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import {
	type DramaAssessmentOutput,
	type DramaDetectionGenerateFn,
	type DramaDetectionInput,
	dramaAssessmentSchema,
} from "./DramaDetectionService.ts";

/**
 * Effect teaching note: This is the boundary between the Effect world and
 * the Vercel AI SDK, mirroring `GeminiSummarizer.ts`. The new detector uses
 * the canonical AI SDK v6 `output` parameter (the existing summarizer still
 * uses the v5 alias `experimental_output` — out of scope for this slice).
 *
 * `thinkingConfig` gives Gemini 2.5 Flash dedicated reasoning tokens before
 * it emits the structured output, replacing prompt-engineered chain-of-
 * thought entirely. `includeThoughts: true` exposes the reasoning on
 * `result.reasoning` for first-run verification and prompt iteration.
 *
 * The system prompt and `promptVersion` are no longer hardcoded here —
 * they come from a typed `EvalProfile` module under `evals/profiles/`,
 * threaded through composition. This lets the eval harness hold prompt
 * versions side-by-side without forking the detector factory (the
 * `typescript-only-fixes-hiding-runtime-regressions-2026-05-01` solution
 * doc rejects parallel eval-only factories explicitly).
 */

const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_INCLUDE_THOUGHTS = true;

type GeminiDramaDetectorConfig = {
	/** Gemini model ID (e.g. "gemini-2.5-flash"). */
	modelId: string;
	/** Profile version string (e.g. "v1"). Surfaced in stored assessments. */
	promptVersion: string;
	/** System prompt body, sourced from the active `EvalProfile`. */
	systemPrompt: string;
	/** Optional sampling temperature; provider default applies if omitted. */
	temperature?: number;
	/** Reasoning-token budget for Gemini 2.5 thinking; defaults to 4096. */
	thinkingBudget?: number;
	/** Expose reasoning on `result.reasoning`; defaults to true. */
	includeThoughts?: boolean;
};

function buildPrompt(input: DramaDetectionInput): string {
	return `Meeting context: ${input.meetingContext}

Transcript (with inline timestamps):
---
${input.sourceText}
---

Score this meeting against the v1 rubric and return the JSON structure.`;
}

/**
 * Builds a DramaDetectionGenerateFn backed by Gemini 2.5 Flash with native
 * thinking. The Google provider reads GOOGLE_GENERATIVE_AI_API_KEY from the
 * environment automatically — no key is passed here.
 *
 * First-run note: if `result.reasoning` is empty after the first end-to-end
 * call, the structured-output path is suppressing thinking. Fall back by
 * setting `providerOptions.google.structuredOutputs: false` and restoring
 * Output.object via post-validation. This is documented in the methodology
 * doc that ships in slice #5.
 */
function createGeminiDramaDetector(
	config: GeminiDramaDetectorConfig,
): DramaDetectionGenerateFn {
	const thinkingBudget = config.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
	const includeThoughts = config.includeThoughts ?? DEFAULT_INCLUDE_THOUGHTS;

	return async (input: DramaDetectionInput): Promise<DramaAssessmentOutput> => {
		try {
			const { output } = await generateText({
				model: google(config.modelId),
				system: config.systemPrompt,
				prompt: buildPrompt(input),
				...(config.temperature !== undefined
					? { temperature: config.temperature }
					: {}),
				output: Output.object({
					schema: dramaAssessmentSchema,
				}),
				providerOptions: {
					google: {
						thinkingConfig: {
							thinkingBudget,
							includeThoughts,
						},
					} satisfies GoogleGenerativeAIProviderOptions,
				},
			});
			return output;
		} catch (err) {
			// Surface the raw model output and the validation cause so prompt
			// iteration is debuggable. AI SDK wraps schema mismatches as
			// NoObjectGeneratedError with .text (raw) and .cause (Zod issues).
			if (NoObjectGeneratedError.isInstance(err)) {
				if (err.text) {
					console.error("[drama-detector] raw model output:");
					console.error(err.text);
				}
				if (err.cause) {
					console.error("[drama-detector] validation cause:");
					console.error(err.cause);
				}
			}
			throw err;
		}
	};
}

export { createGeminiDramaDetector };
export type { GeminiDramaDetectorConfig };
