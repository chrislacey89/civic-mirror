import { feedbackFrom } from "./feedback.ts";
import { groundedFigureCount } from "./figures.ts";
import { CODE_CHECKS, runCodeChecks } from "./index.ts";
import {
	type CheckContext,
	type CheckReport,
	type CodeCheck,
	type Feedback,
	GATE_IDS,
	type GateId,
	type PrePublishOutcome,
	type Round,
	STYLE_IDS,
	type StyleId,
	type SummaryPublication,
	type WrittenDraft,
} from "./types.ts";

/** The gates that failed or went unchecked. A gate no check owns is not counted. */
function failedGates(report: CheckReport): GateId[] {
	return GATE_IDS.filter((id) => {
		const verdict = report.verdicts[id];
		return verdict !== undefined && verdict.outcome !== "pass";
	});
}

function failedStyles(report: CheckReport): StyleId[] {
	return STYLE_IDS.filter((id) => report.verdicts[id]?.outcome === "fail");
}

function roundOf(
	round: number,
	draft: WrittenDraft,
	context: CheckContext,
	checks: readonly CodeCheck[],
): Round {
	const code = runCodeChecks(draft, context, checks);
	// The style score comes from checks not yet built.
	return {
		round,
		draft,
		code,
		judge: "skipped",
		gateFailures: failedGates(code).length,
		styleScore: 0,
		groundedFigures: groundedFigureCount(draft, context),
	};
}

/** The outcome of publishing `best`'s draft. Never publishes a gate failure. */
function outcomeOf(best: Round, rounds: readonly Round[]): PrePublishOutcome {
	const gateFails = failedGates(best.code);
	if (gateFails.length > 0) {
		return {
			kind: "held",
			reason: "gate-failed",
			best: best.draft,
			gateFails,
			rounds,
		};
	}
	const styleFails = failedStyles(best.code);
	if (styleFails.length > 0) {
		return { kind: "publish-flagged", best: best.draft, styleFails, rounds };
	}
	return { kind: "publish", best: best.draft, rounds };
}

/**
 * Whether `round` is worse than `best`: more gate failures, or as many and a
 * lower style score. A round that keeps fewer grounded figures is worse too,
 * so a writer cannot pass A1 by dropping figures. A round that is not worse
 * ties or improves, and may still have fixed some of a gate's failed items.
 */
function worsens(round: Round, best: Round): boolean {
	if (round.groundedFigures < best.groundedFigures) return true;
	if (round.gateFailures !== best.gateFailures) {
		return round.gateFailures > best.gateFailures;
	}
	return round.styleScore < best.styleScore;
}

function passesEveryCheck(round: Round): boolean {
	return round.gateFailures === 0 && failedStyles(round.code).length === 0;
}

/**
 * Whether one draft may be published: one round of code checks, no
 * revision and no judge, so an unchecked gate holds the draft as a failed
 * one does.
 */
export function checkDraft(args: {
	draft: WrittenDraft;
	context: CheckContext;
	checks?: readonly CodeCheck[];
}): PrePublishOutcome {
	const round = roundOf(
		1,
		args.draft,
		args.context,
		args.checks ?? CODE_CHECKS,
	);
	return outcomeOf(round, [round]);
}

/**
 * Checks a draft and has the writing call revise it from the feedback until
 * every check passes, a round is worse than the best, or `cap` drafts have
 * been written. A round that ties the best replaces it, and the next
 * revision starts from it. The outcome is the best draft's, not the last's;
 * a revision call that fails ends the loop with the best so far.
 */
export async function prePublish(args: {
	draft: WrittenDraft;
	context: CheckContext;
	revise: (feedback: readonly Feedback[]) => Promise<WrittenDraft>;
	cap: number;
	checks?: readonly CodeCheck[];
}): Promise<PrePublishOutcome> {
	const checks = args.checks ?? CODE_CHECKS;
	let best = roundOf(1, args.draft, args.context, checks);
	const rounds = [best];
	while (!passesEveryCheck(best) && rounds.length < args.cap) {
		let draft: WrittenDraft;
		try {
			draft = await args.revise(feedbackFrom(best.code, best.draft));
		} catch {
			break;
		}
		const round = roundOf(rounds.length + 1, draft, args.context, checks);
		rounds.push(round);
		if (worsens(round, best)) break;
		best = round;
	}
	return outcomeOf(best, rounds);
}

/** What storage records of an outcome. A flagged draft is published. */
export function toPublication(
	outcome: PrePublishOutcome,
	runId: string,
): SummaryPublication {
	return {
		status: outcome.kind === "held" ? "held" : "published",
		heldReason: outcome.kind === "held" ? outcome.reason : null,
		runId,
		rounds: outcome.rounds,
	};
}

/** A publication for a new check run. */
export function newPublication(outcome: PrePublishOutcome): SummaryPublication {
	return toPublication(outcome, crypto.randomUUID());
}

/**
 * One line per gate a held outcome failed, from the round its best draft came
 * from: the gate id and the quoted text, or why it went unchecked.
 */
export function gateEvidence(outcome: PrePublishOutcome): string[] {
	if (outcome.kind !== "held") return [];
	const round = outcome.rounds.find((r) => r.draft === outcome.best);
	return outcome.gateFails.map((id) => {
		const verdict = round?.code.verdicts[id];
		if (verdict?.outcome === "fail") return `${id}: ${verdict.evidence}`;
		if (verdict?.outcome === "unchecked") {
			return `${id}: unchecked (${verdict.reason})`;
		}
		return `${id}: no verdict`;
	});
}
