import { z } from "zod";
import {
	CHECK_IDS,
	type CheckId,
	GATE_IDS,
	type PrePublishOutcome,
	type Round,
	type WriteUp,
} from "#/pipeline/checks/types.ts";

/**
 * One meeting's previewed recheck: the outcome the operator saw, and the run
 * id its rounds are stored under when it is applied.
 */
export interface RecheckEntry {
	readonly meetingId: number;
	readonly runId: string;
	readonly outcome: PrePublishOutcome;
}

const checkId = z.enum(CHECK_IDS as [CheckId, ...CheckId[]]);
const gateId = z.enum(GATE_IDS);

const verdict = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("pass") }),
	z.object({ outcome: z.literal("fail"), evidence: z.string() }),
	z.object({ outcome: z.literal("unchecked"), reason: z.string() }),
]);

const checkReport = z.object({
	verdicts: z.partialRecord(checkId, verdict),
});

const tokenCount = z.number().nullable();

const round = z.object({
	round: z.number().int(),
	draft: z.object({
		highlights: z.array(z.string()),
		prose: z.string(),
		finishReason: z.string().nullable(),
		usage: z
			.object({
				inputTokens: tokenCount,
				outputTokens: tokenCount,
				reasoningTokens: tokenCount,
			})
			.nullable(),
	}),
	code: checkReport,
	judge: z.union([checkReport, z.literal("unavailable"), z.literal("skipped")]),
	judgeFingerprint: z.string().nullable(),
	gateFailures: z.number().int(),
	styleScore: z.number(),
	groundedFigures: z.number().int(),
});

const writeUp = z.object({
	highlights: z.array(z.string()),
	prose: z.string(),
});

/**
 * An outcome as the file holds it. `bestRound` is the index of the round the
 * best draft came from, so reading it back can point `best` at that round's
 * draft again: `gateEvidence` finds the round by identity, not by value. It
 * is required, so a file cannot carry text that no round holds.
 */
const savedOutcome = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("publish"),
		best: writeUp,
		bestRound: z.number().int(),
		rounds: z.array(round).min(1),
	}),
	z.object({
		kind: z.literal("publish-flagged"),
		best: writeUp,
		bestRound: z.number().int(),
		styleFails: z.array(checkId),
		rounds: z.array(round).min(1),
	}),
	z.object({
		kind: z.literal("held"),
		reason: z.enum(["gate-failed", "critic-unavailable"]),
		best: writeUp,
		bestRound: z.number().int(),
		gateFails: z.array(gateId),
		rounds: z.array(round).min(1),
	}),
]);

const savedPreview = z.object({
	version: z.literal(1),
	entries: z.array(
		z.object({
			meetingId: z.number().int(),
			runId: z.string().min(1),
			outcome: savedOutcome,
		}),
	),
});

/** Where a preview run saves its outcomes. `.context/` is git-ignored. */
export function recheckPreviewPath(runId: string): string {
	return `.context/recheck-${runId}.json`;
}

/** A preview's outcomes as the text of its file. */
export function encodeRecheckPreview(entries: readonly RecheckEntry[]): string {
	const saved = {
		version: 1,
		entries: entries.map(({ meetingId, runId, outcome }) => {
			const index = outcome.rounds.findIndex((r) => r.draft === outcome.best);
			return {
				meetingId,
				runId,
				outcome: { ...outcome, bestRound: index === -1 ? null : index },
			};
		}),
	};
	return `${JSON.stringify(saved, null, 2)}\n`;
}

/**
 * The outcomes a preview file holds. Throws when the text is not a preview
 * file, or names a best round that is missing or holds other text.
 */
export function decodeRecheckPreview(text: string): RecheckEntry[] {
	const parsed = savedPreview.safeParse(JSON.parse(text));
	if (!parsed.success) {
		throw new Error(
			`Not a recheck preview file: ${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data.entries.map(({ meetingId, runId, outcome }) => {
		const { bestRound, ...rest } = outcome;
		const rounds: readonly Round[] = rest.rounds;
		const draft = rounds[bestRound]?.draft;
		if (
			draft === undefined ||
			draft.prose !== rest.best.prose ||
			JSON.stringify(draft.highlights) !== JSON.stringify(rest.best.highlights)
		) {
			throw new Error(
				`Not a recheck preview file: meeting ${meetingId}'s best draft is not round ${bestRound}'s.`,
			);
		}
		if (rest.kind !== "held" && rounds[bestRound]?.gateFailures !== 0) {
			throw new Error(
				`Not a recheck preview file: meeting ${meetingId} is marked to publish, but round ${bestRound} fails a gate.`,
			);
		}
		const best: WriteUp = draft;
		return {
			meetingId,
			runId,
			outcome: { ...rest, best, rounds },
		};
	});
}

/**
 * The entry a preview file holds for one meeting. Throws, naming the meeting
 * id and the file, when the file has none.
 */
export function recheckEntryFor(
	entries: readonly RecheckEntry[],
	meetingId: number,
	source: string,
): RecheckEntry {
	const entry = entries.find((e) => e.meetingId === meetingId);
	if (entry === undefined) {
		throw new Error(`${source} holds no preview for meeting id ${meetingId}.`);
	}
	return entry;
}
