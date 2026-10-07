import { Effect } from "effect";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import {
	type MeetingSources,
	StorageService,
} from "#/pipeline/services/StorageService.ts";
import type { LabelledSource } from "#/pipeline/services/SummarizationService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import {
	computeSourceFingerprint,
	type SourceKind,
} from "#/pipeline/sources.ts";

/** The fingerprint of every source URL a meeting holds, readable or not. */
function fingerprintHeldSources(held: MeetingSources): string {
	const sourceUrls = held.documents.map((document) => document.sourceUrl);
	if (held.transcript?.sourceUrl) sourceUrls.push(held.transcript.sourceUrl);
	return computeSourceFingerprint(sourceUrls);
}

/**
 * Rebuilds a meeting's summary from every source it holds, and replaces the
 * stored one. Regenerates only when the fingerprint of the meeting's current
 * sources differs from the stored one, so calling it again with the same
 * sources costs no summarize call.
 *
 * A summary stored without a fingerprint never matches, so the caller decides
 * whether such a meeting is due: this function would regenerate it.
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

		// Every source URL counts, readable or not: an unreadable document is a
		// source the summary has already accounted for, and leaving it out would
		// make the meeting look changed on every run.
		const sourceFingerprint = fingerprintHeldSources(held);
		if (held.summary?.sourceFingerprint === sourceFingerprint) {
			return { regenerated: false };
		}

		const sources: LabelledSource[] = held.documents
			.filter((document) => document.rawText.trim() !== "")
			.map((document) => ({ kind: "documents", text: document.rawText }));
		if (held.transcript && held.transcript.rawText.trim() !== "") {
			sources.push({ kind: "transcript", text: held.transcript.rawText });
		}
		if (sources.length === 0) return { regenerated: false };

		const summary = yield* summarizer.summarize({
			sources,
			meetingContext: input.meetingContext,
		});

		const sourceKinds = (["documents", "transcript"] as const).filter((kind) =>
			sources.some((source) => source.kind === kind),
		) satisfies SourceKind[];

		yield* storage.replaceMeetingSummary({
			meetingId: input.meetingId,
			summary: {
				highlights: summary.highlights,
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: summary.fiscalDecisions,
			budgetDiscussions: summary.budgetDiscussions,
			sourceKinds,
			sourceFingerprint,
			sourceDisagreements: summary.sourceDisagreements,
		});

		return { regenerated: true };
	});
}

export { fingerprintHeldSources, regenerateMeetingSummary };
