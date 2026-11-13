import { feedbackFrom } from "./feedback.ts";
import { groundedFigureCount } from "./figures.ts";
import { CODE_CHECKS, runCodeChecks } from "./index.ts";
import {
	gatedFor,
	JUDGE_DECIDES_UNCHECKED_ONLY,
	JUDGE_OWNS,
	type Judge,
	type JudgeInput,
} from "./judge.ts";
import {
	type CheckContext,
	type CheckId,
	type CheckReport,
	type CodeCheck,
	GATE_IDS,
	type GateId,
	type PrePublishOutcome,
	type Revision,
	type Round,
	STYLE_IDS,
	type StyleId,
	type SummaryPublication,
	type WriteUp,
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

/** How one check run treats a meeting: its code checks, and its judge if any. */
interface Checking {
	readonly context: CheckContext;
	readonly checks: readonly CodeCheck[];
	readonly judge: Judge | undefined;
	/** The gates the judge's verdict decides on this meeting. */
	readonly gated: readonly GateId[];
}

function checkingOf(args: {
	context: CheckContext;
	checks?: readonly CodeCheck[] | undefined;
	judge?: Judge | undefined;
}): Checking {
	return {
		context: args.context,
		checks: args.checks ?? CODE_CHECKS,
		judge: args.judge,
		gated: args.judge === undefined ? [] : gatedFor(args.context.input),
	};
}

/**
 * The gates code failed, less the gated ones it left unchecked for the
 * judge to decide. The judge runs only when this is empty, and the revise
 * loop measures improvement by it alone.
 */
function codeGateFails(code: CheckReport, gated: readonly GateId[]): GateId[] {
	return failedGates(code).filter(
		(id) => !(gated.includes(id) && code.verdicts[id]?.outcome === "unchecked"),
	);
}

/**
 * The verdicts the outcome rests on: code's, with each gated check the judge
 * decides replaced by the judge's verdict. The judge decides a gated check
 * code left unchecked, and one code passed unless it is in
 * `JUDGE_DECIDES_UNCHECKED_ONLY`.
 */
function decided(round: Round, gated: readonly GateId[]): CheckReport {
	const { judge } = round;
	if (typeof judge === "string") return round.code;
	const overrides = gated.flatMap((id) => {
		const code = round.code.verdicts[id];
		const judged = judge.verdicts[id];
		if (judged === undefined || code?.outcome === "fail") return [];
		if (
			code?.outcome !== "unchecked" &&
			JUDGE_DECIDES_UNCHECKED_ONLY.includes(id)
		) {
			return [];
		}
		return [[id, judged] as const];
	});
	return {
		verdicts: { ...round.code.verdicts, ...Object.fromEntries(overrides) },
	};
}

/** The judge's fails that decide nothing: they flag the draft but never hold it. */
function judgeFlags(round: Round, gated: readonly GateId[]): CheckId[] {
	const { judge } = round;
	if (typeof judge === "string") return [];
	const verdicts = decided(round, gated).verdicts;
	return JUDGE_OWNS.filter(
		(id) =>
			judge.verdicts[id]?.outcome === "fail" &&
			verdicts[id] !== judge.verdicts[id],
	);
}

/**
 * The judge's report on a draft, or "unavailable" when it throws, says so,
 * or leaves out a check it owns.
 */
async function ask(
	judge: Judge,
	input: JudgeInput,
): Promise<CheckReport | "unavailable"> {
	try {
		const report = await judge.run(input);
		if (report === "unavailable") return report;
		const complete = JUDGE_OWNS.every(
			(id) => report.verdicts[id] !== undefined,
		);
		return complete ? report : "unavailable";
	} catch {
		return "unavailable";
	}
}

/** A round of code checks alone; the judge is not asked. */
function codeRound(
	round: number,
	draft: WrittenDraft,
	checking: Checking,
): Round {
	const { context } = checking;
	const code = runCodeChecks(draft, context, checking.checks);
	return {
		round,
		draft,
		code,
		judge: "skipped",
		judgeFingerprint: null,
		gateFailures: failedGates(code).length,
		// The style score comes from checks not yet built.
		styleScore: 0,
		groundedFigures: groundedFigureCount(draft, context),
	};
}

/** A round of code checks, then the judge when code's gates leave it to decide. */
async function roundOf(
	round: number,
	draft: WrittenDraft,
	checking: Checking,
): Promise<Round> {
	const coded = codeRound(round, draft, checking);
	const { context, judge, gated } = checking;
	if (judge === undefined || codeGateFails(coded.code, gated).length > 0) {
		return coded;
	}
	const judged: Round = {
		...coded,
		judge: await ask(judge, { context, draft }),
		judgeFingerprint: judge.fingerprint,
	};
	return {
		...judged,
		gateFailures: failedGates(decided(judged, gated)).length,
	};
}

/** Whether the judge was needed to decide a gate and could not be asked. */
function judgeMissing(round: Round, gated: readonly GateId[]): boolean {
	return gated.length > 0 && round.judge === "unavailable";
}

/** The outcome of publishing `best`'s draft. Never publishes a gate failure. */
function outcomeOf(
	best: Round,
	rounds: readonly Round[],
	gated: readonly GateId[],
): PrePublishOutcome {
	const gateFails = failedGates(decided(best, gated));
	if (judgeMissing(best, gated)) {
		return {
			kind: "held",
			reason: "critic-unavailable",
			best: best.draft,
			gateFails,
			rounds,
		};
	}
	if (gateFails.length > 0) {
		return {
			kind: "held",
			reason: "gate-failed",
			best: best.draft,
			gateFails,
			rounds,
		};
	}
	const styleFails = [...failedStyles(best.code), ...judgeFlags(best, gated)];
	if (styleFails.length > 0) {
		return { kind: "publish-flagged", best: best.draft, styleFails, rounds };
	}
	return { kind: "publish", best: best.draft, rounds };
}

/**
 * Whether `round` is worse than `best`: more gate failures by code, or as
 * many and a lower style score. Judge verdicts are left out, so a judge's
 * variance cannot end the loop. A round that keeps fewer grounded figures is
 * worse too, so a writer cannot pass A1 by dropping figures. A round that is
 * not worse ties or improves, and may still have fixed some of a gate's
 * failed items.
 */
function worsens(round: Round, best: Round, gated: readonly GateId[]): boolean {
	if (round.groundedFigures < best.groundedFigures) return true;
	const fails = codeGateFails(round.code, gated).length;
	const bestFails = codeGateFails(best.code, gated).length;
	if (fails !== bestFails) return fails > bestFails;
	return round.styleScore < best.styleScore;
}

/** The revision's text, as the writing prompt gives it. */
function revisionOf(round: Round, gated: readonly GateId[]): Revision {
	const { highlights, prose } = round.draft;
	const draft: WriteUp = { highlights, prose };
	return { feedback: feedbackFrom(decided(round, gated), draft), draft };
}

function sameRevision(a: Revision, b: Revision): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
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
	const checking = checkingOf(args);
	const round = codeRound(1, args.draft, checking);
	return outcomeOf(round, [round], checking.gated);
}

/**
 * Checks a draft and has the writing call revise it from the feedback until
 * every check passes, a round is worse than the best, a round's draft and
 * feedback equal the best's (the next prompt would repeat the last), the
 * judge a gate needs is unavailable, or `cap` drafts have been written. A
 * round that ties the best replaces it, and the next revision starts from
 * it. The outcome is the best draft's, not the last's; a revision call that
 * fails ends the loop with the best so far.
 *
 * With a judge, a draft whose code gates pass goes to it. Its fails on the
 * meeting's gated checks hold the draft and go back to the writer; its
 * other fails flag it. Where a gated check needs it and it is unavailable,
 * the draft is held as `critic-unavailable`.
 */
export async function prePublish(args: {
	draft: WrittenDraft;
	context: CheckContext;
	revise: (revision: Revision) => Promise<WrittenDraft>;
	cap: number;
	checks?: readonly CodeCheck[];
	judge?: Judge | undefined;
}): Promise<PrePublishOutcome> {
	const checking = checkingOf(args);
	const { gated } = checking;
	let best = await roundOf(1, args.draft, checking);
	const rounds = [best];
	while (
		!passesEveryCheck(best) &&
		!judgeMissing(best, gated) &&
		rounds.length < args.cap
	) {
		const revision = revisionOf(best, gated);
		let draft: WrittenDraft;
		try {
			draft = await args.revise(revision);
		} catch {
			break;
		}
		const round = await roundOf(rounds.length + 1, draft, checking);
		rounds.push(round);
		if (worsens(round, best, gated)) break;
		const stuck =
			!passesEveryCheck(round) &&
			sameRevision(revision, revisionOf(round, gated));
		best = round;
		if (stuck) break;
	}
	return outcomeOf(best, rounds, gated);
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
 * from: the gate id and the quoted text, or why it went unchecked. A judge's
 * A5 fail quotes nothing, since its quote would name the resident.
 */
export function gateEvidence(outcome: PrePublishOutcome): string[] {
	if (outcome.kind !== "held") return [];
	const round = outcome.rounds.find((r) => r.draft === outcome.best);
	return outcome.gateFails.map((id) => {
		const verdict = round?.code.verdicts[id];
		if (verdict?.outcome === "fail") return `${id}: ${verdict.evidence}`;
		const judged =
			typeof round?.judge === "object" ? round.judge.verdicts[id] : undefined;
		if (judged?.outcome === "fail") {
			return id === "A5"
				? "A5 (judge): a person named in the draft spoke as a member of the public"
				: `${id} (judge): ${judged.evidence}`;
		}
		if (verdict?.outcome === "unchecked") {
			return `${id}: unchecked (${verdict.reason})`;
		}
		return `${id}: no verdict`;
	});
}
