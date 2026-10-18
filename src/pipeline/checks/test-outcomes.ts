import type { SummarizationResult } from "#/pipeline/services/SummarizationService.ts";
import { prePublish, toPublication } from "./prePublish.ts";
import type { SummaryPublication, WriteUp } from "./types.ts";

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

/** What storage records of `text` put through the pre-publish check. */
export function publicationOf(
	text: WriteUp,
	runId = "test-run",
): SummaryPublication {
	return toPublication(
		prePublish({
			draft: { ...text, finishReason: "stop", usage: null },
			context: { input: { sources: [], meetingContext: "" }, ledger: [] },
		}),
		runId,
	);
}

/** A publication for a summary whose check is beside the point of a test. */
export const PUBLISHED: SummaryPublication = {
	status: "published",
	heldReason: null,
	runId: "test-run",
	rounds: [],
};
