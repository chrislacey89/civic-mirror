import type { LabelledSource } from "#/pipeline/sources.ts";
import type { JUDGE_GATED, JUDGE_OWNS } from "./judge.ts";
import {
	type CheckReport,
	GATE_IDS,
	type GateId,
	type WriteUp,
} from "./types.ts";

/** What `calibrate-judge --write` records beside the corpus. */
export interface CalibrationRecord {
	/** The fingerprint of the judge that was calibrated. */
	readonly fingerprint: string;
	readonly model: string;
	/** ISO date. */
	readonly calibratedAt: string;
	/** How many corpus edits reached the judge and were scored. */
	readonly judged: number;
	/** The edits a code gate catches, left out because they measure that check, not the judge. */
	readonly seenByCode: readonly string[];
	readonly scores: Record<
		keyof typeof JUDGE_GATED,
		Record<(typeof JUDGE_OWNS)[number], CalibrationScore>
	>;
	/**
	 * Gated fails judged twice more with an instruction appended to the
	 * sources: "<id> <check>" for each the judge passed in both of those runs
	 * (`flipped`), or in one of them (`flippedOnce`, within the judge's own
	 * run-to-run disagreement).
	 */
	readonly injection: {
		readonly probed: number;
		readonly flipped: readonly string[];
		readonly flippedOnce: readonly string[];
	};
}

/**
 * One edit from the calibration corpus
 * (`__fixtures__/calibration/corpus.json`; its README says how one is made).
 */
export interface CorpusEdit {
	readonly id: string;
	readonly target:
		| { readonly field: "highlights"; readonly index: number }
		| { readonly field: "prose"; readonly sentence: string };
	readonly before: string;
	readonly after: string;
	/**
	 * Changes to the meeting's documents that the draft edit needs, applied
	 * in order: an invented name standing in for the resident the minutes
	 * name, or a public-comment heading removed so the minutes no longer
	 * mark the section.
	 */
	readonly sourceEdits?: readonly SourceEdit[];
}

/**
 * Whether code says something about the edited draft it did not say about
 * the base. Code catches such an edit before the judge would see it, so the
 * edit measures that check, not the judge: an invented name trips A1, a
 * listed loaded word trips code A2. One change does not count: a gate in
 * `deferred` going unchecked, since code then leaves that gate to the judge.
 * A base draft a code gate holds for something else still measures the
 * judge, since the edit is no easier for it.
 */
export function codeSeesEdit(
	base: CheckReport,
	edited: CheckReport,
	deferred: readonly GateId[],
): boolean {
	return GATE_IDS.some((id) => {
		const before = base.verdicts[id];
		const after = edited.verdicts[id];
		if (JSON.stringify(before) === JSON.stringify(after)) return false;
		return !(deferred.includes(id) && after?.outcome === "unchecked");
	});
}

/** An exact-string replace of one occurrence across a meeting's documents. */
export interface SourceEdit {
	readonly before: string;
	readonly after: string;
}

/**
 * The sources with each edit applied to the documents, or null when an
 * edit's `before` is not in them exactly once: the stored sources have
 * changed since the corpus was written. A transcript is never edited.
 */
export function applySourceEdits(
	sources: readonly LabelledSource[],
	edits: readonly SourceEdit[],
): LabelledSource[] | null {
	let edited = [...sources];
	for (const edit of edits) {
		const holding = edited.filter(
			(source) =>
				source.kind === "documents" && source.text.includes(edit.before),
		);
		const [source] = holding;
		if (source === undefined || holding.length > 1) return null;
		const text = replacedOnce(source.text, edit.before, edit.after);
		if (text === null) return null;
		edited = edited.map((each) => (each === source ? { ...each, text } : each));
	}
	return edited;
}

/** `text` with its one occurrence of `before` replaced, or null if it has none or several. */
function replacedOnce(
	text: string,
	before: string,
	after: string,
): string | null {
	const at = text.indexOf(before);
	if (at < 0 || text.indexOf(before, at + 1) >= 0) return null;
	return text.slice(0, at) + after + text.slice(at + before.length);
}

/**
 * The draft with the edit applied, or null when `before` no longer occurs
 * exactly once where the edit targets: the stored draft has changed since
 * the corpus was written, and the edit does not apply.
 */
export function applyEdit(draft: WriteUp, edit: CorpusEdit): WriteUp | null {
	if (edit.target.field === "prose") {
		const prose = replacedOnce(draft.prose, edit.before, edit.after);
		return prose === null ? null : { ...draft, prose };
	}
	const { index } = edit.target;
	const highlight = draft.highlights[index];
	if (highlight === undefined) return null;
	const edited = replacedOnce(highlight, edit.before, edit.after);
	if (edited === null) return null;
	const highlights = [...draft.highlights];
	highlights[index] = edited;
	return { ...draft, highlights };
}

type Label = "pass" | "fail";

/** How a judge did on one check across two runs over the corpus. */
export interface CalibrationScore {
	readonly n: number;
	/** How many items are labelled fail. */
	readonly fails: number;
	/** Per run: the share of fail items it failed; null with no fail items. */
	readonly catchRate: readonly [number | null, number | null];
	/** Per run: the share of pass items it failed; null with no pass items. */
	readonly falseRefusal: readonly [number | null, number | null];
	/** The share of items both runs gave the same verdict. */
	readonly selfAgreement: number;
}

/** The share of `items` whose verdict in `run` is fail; null when there are none. */
function failShare(
	items: readonly { runs: readonly [Label, Label] }[],
	run: 0 | 1,
): number | null {
	if (items.length === 0) return null;
	return (
		items.filter((item) => item.runs[run] === "fail").length / items.length
	);
}

/** The score of one check's verdicts against the corpus labels. */
export function scoreCheck(
	items: readonly { label: Label; runs: readonly [Label, Label] }[],
): CalibrationScore {
	const fails = items.filter((item) => item.label === "fail");
	const passes = items.filter((item) => item.label === "pass");
	return {
		n: items.length,
		fails: fails.length,
		catchRate: [failShare(fails, 0), failShare(fails, 1)],
		falseRefusal: [failShare(passes, 0), failShare(passes, 1)],
		selfAgreement:
			items.filter((item) => item.runs[0] === item.runs[1]).length /
			items.length,
	};
}

/**
 * The bars a judge must clear, in both runs, to gate a check: PRD #193 ›
 * Calibration's three rates, measured on at least `minFails` fail edits that
 * reach the judge, so one lucky catch cannot clear a check.
 */
export const BARS = {
	minFails: 10,
	catchRate: 0.9,
	falseRefusal: 0.1,
	selfAgreement: 0.9,
} as const;

/** Whether a score clears every bar. */
export function clearsBars(score: CalibrationScore): boolean {
	return (
		score.fails >= BARS.minFails &&
		score.catchRate.every((rate) => rate !== null && rate >= BARS.catchRate) &&
		score.falseRefusal.every(
			(rate) => rate === null || rate <= BARS.falseRefusal,
		) &&
		score.selfAgreement >= BARS.selfAgreement
	);
}
