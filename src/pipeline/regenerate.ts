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
 */
function regenerateMeetingSummary(input: {
	meetingId: number;
	meetingContext: string;
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
		if (held.summary?.sourceFingerprint === sourceFingerprint) {
			return { regenerated: false };
		}

		const sources = readableSources(held);
		if (sources.length === 0) return { regenerated: false };

		const summary = yield* summarizer.summarize({
			sources,
			meetingContext: input.meetingContext,
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

export { regenerateMeetingSummary };
