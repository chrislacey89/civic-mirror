import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { MatchDecideFn } from "./MeetingMatchService.ts";

/**
 * Effect teaching note: This is the boundary between the Effect world and
 * the Vercel AI SDK, mirroring `GeminiSummarizer.ts`. `MeetingMatchService`
 * owns the question and the decision rule; this file owns only the model
 * call, so swapping vendors means writing another `MatchDecideFn`.
 */

type GeminiMeetingMatcherConfig = {
	/** Gemini model ID (e.g. "gemini-2.5-flash"). */
	modelId: string;
};

// The field name and description say what the number is a probability of.
// An unnamed probability comes back as the model's confidence in its own
// answer. Plain number only: Gemini's structured output rejects numeric enums.
const matchDecisionSchema = z.object({
	probabilitySameMeeting: z
		.number()
		.describe(
			"Probability from 0 to 1 that A and B are the same meeting. Near 0 when they are different meetings.",
		),
});

/**
 * Builds a MatchDecideFn backed by Gemini. The Google provider reads
 * GOOGLE_GENERATIVE_AI_API_KEY from the environment automatically.
 */
function createGeminiMeetingMatcher(
	config: GeminiMeetingMatcherConfig,
): MatchDecideFn {
	return async ({ question, a, b }) => {
		const { output } = await generateText({
			model: google(config.modelId),
			prompt: `${question}\n\nSummary A:\n${a}\n\nSummary B:\n${b}`,
			output: Output.object({ schema: matchDecisionSchema }),
		});
		return { probabilitySameMeeting: output.probabilitySameMeeting };
	};
}

export { createGeminiMeetingMatcher };
export type { GeminiMeetingMatcherConfig };
