import { Effect } from "effect";
import { gateEvidence, toPublication } from "#/pipeline/checks/prePublish.ts";
import type { PrePublishOutcome } from "#/pipeline/checks/types.ts";
import type { DatabaseError, LlmError } from "#/pipeline/errors.ts";
import type { Official } from "#/pipeline/officials/types.ts";
import type { RecheckEntry } from "#/pipeline/recheckPreview.ts";
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
 * Rewrite a meeting's summary text and put it through the pre-publish check,
 * under a new run id. Nothing is written: the operator reads the outcome,
 * and `applyRecheckEntry` stores that same outcome when they confirm it.
 */
function previewMeetingRecheck(
	input: RewriteInput,
): Effect.Effect<
	RecheckEntry,
	DatabaseError | LlmError,
	StorageService | SummarizationService
> {
	return rewriteMeetingSummary(input).pipe(
		Effect.map(({ meetingId, outcome }) => ({
			meetingId,
			runId: crypto.randomUUID(),
			outcome,
		})),
	);
}

/**
 * Store a previewed outcome as the meeting's summary text and publication,
 * its rounds under the preview's run id. The model is not called, so what is
 * stored is what was previewed.
 */
function applyRecheckEntry(
	entry: RecheckEntry,
): Effect.Effect<void, DatabaseError, StorageService> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		yield* storage.replaceSummaryText({
			meetingId: entry.meetingId,
			highlights: entry.outcome.best.highlights,
			prose: entry.outcome.best.prose,
			publication: toPublication(entry.outcome, entry.runId),
		});
	});
}

/**
 * The preview `summaries:recheck` prints: the outcome kind, each failing gate
 * with its evidence, and the new headline. The evidence is redacted by
 * `gateEvidence`; the headline is not checked for resident names, so when A5
 * fails it is withheld.
 */
function describeRecheck(outcome: PrePublishOutcome): string[] {
	const kind =
		outcome.kind === "held"
			? `held (${outcome.reason})`
			: outcome.kind === "publish-flagged"
				? `publish-flagged (${outcome.styleFails.join(", ")})`
				: "publish";
	const namesResident =
		outcome.kind === "held" && outcome.gateFails.includes("A5");
	const gates =
		outcome.kind !== "held" || outcome.gateFails.length === 0
			? "-"
			: gateEvidence(outcome)
					.map((line) => line.replace(/\s*\n\s*/g, " / "))
					.join("  |  ");
	const headline = namesResident
		? "(withheld: A5 fails)"
		: (outcome.best.highlights[0] ?? "(no highlights)");
	return [
		`  outcome:       ${kind}`,
		`  gate failures: ${gates}`,
		`  headline:      ${headline}`,
	];
}

export {
	applyRecheckEntry,
	describeRecheck,
	previewMeetingRecheck,
	rewriteMeetingSummary,
};
export type { RewriteInput };
