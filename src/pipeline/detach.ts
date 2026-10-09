import { Effect } from "effect";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import { regenerateMeetingSummary } from "#/pipeline/regenerate.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import type { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import { readableSources } from "#/pipeline/sources.ts";

/**
 * What a detach did. `last-source` removed nothing: the meeting would have
 * been left with a summary and no source to build one from. `not-held` found
 * no document under the URL.
 */
type DetachOutcome =
	| { outcome: "detached"; regenerated: boolean }
	| { outcome: "not-held"; regenerated: boolean }
	| { outcome: "last-source" };

/**
 * Removes one document from a meeting and rebuilds the meeting's summary from
 * the sources that remain.
 *
 * The summary is rebuilt whenever it is behind the sources held, including
 * when the document is already gone, so a call whose rebuild failed can be
 * made again to finish it.
 */
function detachDocumentAndRegenerate(input: {
	meetingId: number;
	sourceUrl: string;
	meetingContext: string;
	glossary?: readonly string[];
}): Effect.Effect<
	DetachOutcome,
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;

		const held = yield* storage.getMeetingSources(input.meetingId);
		const isHeld = held.documents.some((d) => d.sourceUrl === input.sourceUrl);

		if (isHeld) {
			const remaining = readableSources({
				documents: held.documents.filter(
					(d) => d.sourceUrl !== input.sourceUrl,
				),
				transcript: held.transcript,
			});
			if (remaining.length === 0) return { outcome: "last-source" };

			// `regenerateMeetingSummary` leaves a summary stored without a
			// fingerprint alone. Stamping it with the sources it was built from
			// makes the detach leave it visibly behind and due.
			yield* storage.stampSummarySources({
				meetingId: input.meetingId,
				builtFrom: held,
			});
			yield* storage.detachDocument({
				meetingId: input.meetingId,
				sourceUrl: input.sourceUrl,
			});
		}

		const { regenerated } = yield* regenerateMeetingSummary({
			meetingId: input.meetingId,
			meetingContext: input.meetingContext,
			glossary: input.glossary,
		});
		return { outcome: isHeld ? "detached" : "not-held", regenerated };
	});
}

export { detachDocumentAndRegenerate };
export type { DetachOutcome };
