import { Effect } from "effect";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import {
	fingerprintOfSources,
	kindsOfReadableSources,
	readableSources,
} from "#/pipeline/sources.ts";

/**
 * Rebuilds a meeting's summary from every source it holds, and replaces the
 * stored one. Regenerates only when the fingerprint of the meeting's current
 * sources differs from the stored one, so calling it again with the same
 * sources costs no summarize call.
 *
 * A summary stored with an empty fingerprint predates fingerprints, and
 * nothing is known about the sources it was built from. Having no fingerprint
 * does not make it due, so it is left alone: regenerating on that alone would
 * send every such meeting back through the summarizer. A caller that adds a
 * source to such a meeting must first stamp the summary with the fingerprint
 * of the sources it held and the one kind it read (`stampSummarySources`),
 * which makes its fingerprint differ from the sources now held.
 *
 * `force` regenerates a summary whose fingerprint is current, for when the
 * summarizer changed and the sources did not. It does not reach a summary
 * stored without a fingerprint.
 */
function regenerateMeetingSummary(input: {
	meetingId: number;
	meetingContext: string;
	glossary: readonly string[] | undefined;
	force?: boolean;
}): Effect.Effect<
	{ regenerated: boolean },
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const summarizer = yield* SummarizationService;

		const held = yield* storage.getMeetingSources(input.meetingId);

		const sourceFingerprint = fingerprintOfSources({
			documents: held.documents,
			transcriptUrl: held.transcript?.sourceUrl,
		});
		if (held.summary?.sourceFingerprint === "") return { regenerated: false };
		if (!input.force && held.summary?.sourceFingerprint === sourceFingerprint) {
			return { regenerated: false };
		}

		const sources = readableSources(held);
		if (sources.length === 0) return { regenerated: false };

		const summary = yield* summarizer.summarize({
			sources,
			meetingContext: input.meetingContext,
			glossary: input.glossary,
		});

		yield* storage.replaceMeetingSummary({
			meetingId: input.meetingId,
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
			sourceKinds: kindsOfReadableSources(sources),
			sourceFingerprint,
			sourceDisagreements: summary.sourceDisagreements,
		});

		return { regenerated: true };
	});
}

/** What became of one meeting in a `regenerateCombinedSummaries` run. */
type RegenerationOutcome = {
	meetingId: number;
	date: string;
	outcome: "regenerated" | "skipped" | "failed";
	/** Why the summarizer failed, when it did. */
	message?: string;
};

/**
 * Summarizes again every meeting of a body whose summary was built from both
 * documents and a transcript, whether or not its sources changed. For when
 * the summarizer's handling of the two kinds together changed. A summarizer
 * failure on one meeting leaves its summary in place and the run carries on.
 */
function regenerateCombinedSummaries(input: {
	body: { slug: string; name: string; glossary?: readonly string[] };
	/** Only the meeting on this date. */
	date?: string;
}): Effect.Effect<
	RegenerationOutcome[],
	DatabaseError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const meetings = yield* storage.listCombinedSummaryMeetings({
			bodySlug: input.body.slug,
			date: input.date,
		});

		const outcomes: RegenerationOutcome[] = [];
		for (const meeting of meetings) {
			const outcome = yield* regenerateMeetingSummary({
				meetingId: meeting.meetingId,
				meetingContext: `${input.body.name}, ${meeting.date}`,
				glossary: input.body.glossary,
				force: true,
			}).pipe(
				Effect.map(({ regenerated }) => ({
					outcome: regenerated
						? ("regenerated" as const)
						: ("skipped" as const),
				})),
				Effect.catchTag("LlmError", (error) =>
					Effect.succeed({
						outcome: "failed" as const,
						message: error.message,
					}),
				),
			);
			outcomes.push({ ...meeting, ...outcome });
		}
		return outcomes;
	});
}

/**
 * Why a regeneration run cannot be called complete, or null when every
 * meeting it found was rebuilt. A run that found no meeting, one that failed
 * on a meeting, and one that skipped a meeting all leave a summary as it was,
 * so none of them may show as passed.
 */
function incompleteRegeneration(
	outcomes: readonly RegenerationOutcome[],
): string | null {
	if (outcomes.length === 0) {
		return "No meeting with a combined summary matched, so nothing was rebuilt.";
	}
	const failed = outcomes.filter((o) => o.outcome === "failed").length;
	const skipped = outcomes.filter((o) => o.outcome === "skipped").length;
	if (failed === 0 && skipped === 0) return null;
	return `${failed} meeting(s) failed and ${skipped} were skipped; each kept its previous summary.`;
}

export {
	incompleteRegeneration,
	regenerateCombinedSummaries,
	regenerateMeetingSummary,
};
export type { RegenerationOutcome };
