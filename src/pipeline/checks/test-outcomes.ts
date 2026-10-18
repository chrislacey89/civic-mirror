import type { SummarizationResult } from "#/pipeline/services/SummarizationService.ts";
import { prePublish } from "./prePublish.ts";

/**
 * A summarizer result as the service would return it: its text put through
 * the pre-publish check. For tests that stub the summarizer.
 */
export function summarized(
	result: Omit<SummarizationResult, "prePublish">,
): SummarizationResult {
	return {
		...result,
		prePublish: prePublish({
			draft: {
				highlights: result.highlights,
				prose: result.prose,
				finishReason: "stop",
				usage: null,
			},
			context: {
				input: { sources: [], meetingContext: "" },
				ledger: result.fiscalDecisions,
			},
		}),
	};
}
