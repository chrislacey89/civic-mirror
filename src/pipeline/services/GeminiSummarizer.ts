import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import type {
	SummarizationGenerateFn,
	SummarizationInput,
	SummarizationOutput,
} from "./SummarizationService.ts";
import { summarizationOutputSchema } from "./SummarizationService.ts";

/**
 * Effect teaching note: This file is the boundary between the Effect world
 * and the Vercel AI SDK. It's deliberately kept out of SummarizationService.ts
 * so that the service module has no transitive dependency on @ai-sdk/google
 * at import time — tests can import SummarizationService without pulling in
 * the AI SDK and paying its module-load cost.
 *
 * `createGeminiSummarizer` returns a plain async function that matches the
 * `SummarizationGenerateFn` contract. The orchestrator injects this into
 * `SummarizationServiceLive` in production; tests inject a stub instead.
 */

type GeminiSummarizerConfig = {
	/** Gemini model ID (e.g. "gemini-2.5-flash"). */
	modelId: string;
};

const SYSTEM_INSTRUCTIONS = `
You are a civic journalism assistant summarizing local government meeting records for a public transparency website.

Your job is to extract a factual, neutral summary of what happened in the meeting, plus structured fiscal decisions where money was discussed or voted on.

CRITICAL RULES:
1. Only extract fiscal decisions that were formally moved, seconded, or voted on. Do not include historical spending references or "we spent X last year" mentions.
2. For each fiscal decision, include the exact originalAmount string as it appears in the source (e.g. "$50,000" not "50000").
3. For items that were discussed with dollar amounts but NOT voted on, put them in budgetDiscussions instead of fiscalDecisions.
4. Set confidence (0.0-1.0) based on how clear the decision was. A clear motion and vote = 0.9+. Ambiguous discussion = 0.5-0.7.
5. Set isRecurring true only for ongoing obligations (utility payments, salaries). One-time purchases are false.
6. Do not editorialize. Report what the record says, not what you think of it.
`.trim();

function buildPrompt(input: SummarizationInput): string {
	return `
Meeting context: ${input.meetingContext}

Source text (meeting minutes or transcript):
---
${input.sourceText}
---

Produce a structured summary of this meeting.
`.trim();
}

/**
 * Builds a SummarizationGenerateFn backed by Gemini via @ai-sdk/google.
 *
 * The Google provider reads GOOGLE_GENERATIVE_AI_API_KEY from the environment
 * automatically, so no API key is passed here. Callers construct this in the
 * CLI entry point where env config is loaded via dotenv, and pass the result
 * into SummarizationServiceLive.
 */
function createGeminiSummarizer(
	config: GeminiSummarizerConfig,
): SummarizationGenerateFn {
	return async (input: SummarizationInput): Promise<SummarizationOutput> => {
		const { experimental_output } = await generateText({
			model: google(config.modelId),
			system: SYSTEM_INSTRUCTIONS,
			prompt: buildPrompt(input),
			experimental_output: Output.object({
				schema: summarizationOutputSchema,
			}),
		});
		return experimental_output;
	};
}

export { createGeminiSummarizer };
export type { GeminiSummarizerConfig };
