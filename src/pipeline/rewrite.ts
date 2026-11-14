import { Effect } from "effect";
import { newPublication } from "#/pipeline/checks/prePublish.ts";
import type { PrePublishOutcome } from "#/pipeline/checks/types.ts";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import type { Official } from "#/pipeline/officials/types.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import { readableSources } from "#/pipeline/sources.ts";

/** What the writing call needs to know about a meeting besides its sources and ledger. */
type RewriteInput = {
	meetingId: number;
	meetingContext: string;
	glossary: readonly string[] | undefined;
	officials: readonly Official[];
};

/**
 * Write a meeting's summary text again from the sources and the ledger it
 * already stores, and put it through the pre-publish check. The ledger is
 * read, never redrawn, so this is the re-run to use when only the writing or
 * the checks changed. Nothing is written; the caller stores the outcome.
 */
function rewriteMeetingSummary(
	input: RewriteInput,
): Effect.Effect<
	{ meetingId: number; outcome: PrePublishOutcome },
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const summarizer = yield* SummarizationService;

		const held = yield* storage.getMeetingSources(input.meetingId);
		const ledger = yield* storage.getStoredLedger(input.meetingId);
		const outcome = yield* summarizer.rewrite(
			{
				sources: readableSources(held),
				meetingContext: input.meetingContext,
				glossary: input.glossary,
				officials: input.officials,
			},
			ledger,
		);
		return { meetingId: input.meetingId, outcome };
	});
}

/**
 * Rewrite a meeting's summary text and, with `confirm`, store it with its
 * publication state. Without `confirm` nothing is written. A writing call
 * that fails leaves the stored summary as it was.
 */
function recheckMeetingSummary(
	input: RewriteInput & { confirm: boolean },
): Effect.Effect<
	{ meetingId: number; outcome: PrePublishOutcome; written: boolean },
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const { outcome } = yield* rewriteMeetingSummary(input);
		if (!input.confirm) {
			return { meetingId: input.meetingId, outcome, written: false };
		}
		yield* storage.replaceSummaryText({
			meetingId: input.meetingId,
			highlights: outcome.best.highlights,
			prose: outcome.best.prose,
			publication: newPublication(outcome),
		});
		return { meetingId: input.meetingId, outcome, written: true };
	});
}

export { recheckMeetingSummary, rewriteMeetingSummary };
export type { RewriteInput };
