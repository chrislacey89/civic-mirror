import { Effect } from "effect";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { SummarizationService } from "#/pipeline/services/SummarizationService.ts";
import {
	fingerprintOfSources,
	kindsOfReadableSources,
	readableSources,
} from "#/pipeline/sources.ts";

/** One fiscal decision as a line: its title and the amount as written. */
function decisionLabel(decision: {
	title: string;
	originalAmount?: string | null;
}): string {
	return decision.originalAmount
		? `${decision.title} (${decision.originalAmount})`
		: decision.title;
}

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
 * `force` skips both checks, for rebuilding summaries after the summarizer
 * itself changed. A meeting with no readable source is still left alone.
 *
 * `preview` summarizes but stores nothing, and returns the decisions the
 * rebuilt summary holds as `rebuilt`.
 */
function regenerateMeetingSummary(input: {
	meetingId: number;
	meetingContext: string;
	/** Rebuild whatever the stored fingerprint says. */
	force?: boolean;
	/** Summarize, store nothing, and report the rebuilt decisions. */
	preview?: boolean;
}): Effect.Effect<
	{ regenerated: boolean; rebuilt?: string[] },
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
		if (!input.force) {
			if (held.summary?.sourceFingerprint === "") return { regenerated: false };
			if (held.summary?.sourceFingerprint === sourceFingerprint) {
				return { regenerated: false };
			}
		}

		const sources = readableSources(held);
		if (sources.length === 0) return { regenerated: false };

		const summary = yield* summarizer.summarize({
			sources,
			meetingContext: input.meetingContext,
		});

		if (input.preview) {
			return {
				regenerated: false,
				rebuilt: summary.fiscalDecisions.map(decisionLabel),
			};
		}

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

/**
 * What happened to the summary of the meeting on one date. `previewed` wrote
 * nothing: it holds the decisions stored now and those a rebuild produced.
 */
type RegenerationOutcome =
	| {
			date: string;
			outcome: "regenerated" | "no-meeting" | "no-readable-source";
	  }
	| { date: string; outcome: "previewed"; stored: string[]; rebuilt: string[] }
	| { date: string; outcome: "failed"; message: string };

/**
 * Rebuilds, whatever its fingerprint, the summary of the body's meeting on
 * each date. Only a meeting stored without a session is found. A failed
 * summarize call is reported for its date and the rest still run.
 *
 * Stores nothing unless `confirm` is true. Otherwise each meeting that would
 * be rebuilt is summarized and reported as `previewed`.
 */
function regenerateSummariesOnDates(input: {
	body: { slug: string; name: string };
	dates: readonly string[];
	confirm: boolean;
}): Effect.Effect<
	RegenerationOutcome[],
	DatabaseError,
	StorageService | SummarizationService
> {
	return Effect.forEach(input.dates, (date) =>
		Effect.gen(function* () {
			const storage = yield* StorageService;
			const meeting = yield* storage.getMeetingSourceState({
				bodySlug: input.body.slug,
				date,
				session: "",
			});
			if (meeting === null) {
				return { date, outcome: "no-meeting" } satisfies RegenerationOutcome;
			}
			const stored = (yield* storage.getMatchableSummary(meeting.meetingId))
				?.fiscalDecisions;
			return yield* regenerateMeetingSummary({
				meetingId: meeting.meetingId,
				meetingContext: `${input.body.name}, ${date}`,
				force: true,
				preview: !input.confirm,
			}).pipe(
				Effect.map(({ regenerated, rebuilt }): RegenerationOutcome => {
					if (rebuilt !== undefined) {
						return {
							date,
							outcome: "previewed",
							stored: (stored ?? []).map(decisionLabel),
							rebuilt,
						};
					}
					return {
						date,
						outcome: regenerated ? "regenerated" : "no-readable-source",
					};
				}),
				Effect.catchTag("LlmError", (error) =>
					Effect.succeed<RegenerationOutcome>({
						date,
						outcome: "failed",
						message: error.message,
					}),
				),
			);
		}),
	);
}

export { regenerateMeetingSummary, regenerateSummariesOnDates };
export type { RegenerationOutcome };
