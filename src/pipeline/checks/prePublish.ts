import { groundedFigureCount } from "./figures.ts";
import { CODE_CHECKS, runCodeChecks } from "./index.ts";
import {
	type CheckContext,
	type CheckReport,
	type CodeCheck,
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

/**
 * Whether a draft may be published. One round of code checks, no judge, so
 * an unchecked gate holds the draft as a failed one does. Never publishes a
 * draft with a gate failure.
 */
export function prePublish(args: {
	draft: WrittenDraft;
	context: CheckContext;
	checks?: readonly CodeCheck[];
}): PrePublishOutcome {
	const { draft } = args;
	const code = runCodeChecks(draft, args.context, args.checks ?? CODE_CHECKS);
	const gateFails = failedGates(code);
	// The style score comes from checks not yet built.
	const round: Round = {
		round: 1,
		draft,
		code,
		judge: "skipped",
		gateFailures: gateFails.length,
		styleScore: 0,
		groundedFigures: groundedFigureCount(draft, args.context),
	};
	const rounds = [round];

	if (gateFails.length > 0) {
		return {
			kind: "held",
			reason: "gate-failed",
			best: draft,
			gateFails,
			rounds,
		};
	}
	const styleFails = failedStyles(code);
	if (styleFails.length > 0) {
		return { kind: "publish-flagged", best: draft, styleFails, rounds };
	}
	return { kind: "publish", best: draft, rounds };
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
