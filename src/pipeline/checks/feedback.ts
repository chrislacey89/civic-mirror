import {
	type CheckId,
	type CheckReport,
	type Feedback,
	GATE_IDS,
	STYLE_IDS,
	type WriteUp,
} from "./types.ts";

/**
 * Each check's title as docs/writing-rubric.md writes it, word for word
 * (rubric.test.ts holds them equal). A title carries no worked example, so a
 * finding carries nothing the draft does not.
 */
export const RULES: Readonly<Record<CheckId, string>> = {
	A1: "Every figure, name and vote is in a source",
	A2: "No opinion, no motive, no loaded words",
	A3: "No source artifacts leak",
	A4: "Each sentence says what the source says, not what it was meant to say",
	A5: "Officials by name and role; the public by count",
	TRUNC: "The prose ends at a sentence end",
	B1: "The headline is the one thing you would shout",
	B2: "The headline puts actor, verb and object in its first four words",
	B3: "The headline is twelve words or fewer, with no clause after a comma",
	B4: "The headline names a concrete object",
	C1: "The lede adds a fact the headline did not give",
	C2: "The lede does not set the scene",
	C3: "The lede stands alone",
	C4: "The lede is twenty-five words or fewer",
	D1: "Importance order, not agenda order",
	D2: "Meeting mechanics are cut",
	D3: "Every item a resident could act on is kept, with its date",
	D4: "Three to six highlights, one fact each, 20 words or fewer, none duplicating the lede",
	D5: "Paragraphs of two to five sentences, one item each",
	D6: "Length scales with the meeting, anchored at 300–400 for the largest",
	E1: "The body does the verb",
	E2: "Verbs, not zombie nouns, for first mention",
	E3: "One thought per sentence; 30 words is the ceiling, 18 the average",
	E4: "Varied openings, steady names",
	F1: "No officialese",
	F2: "Jargon is glossed or replaced on first use",
	F3: "No hedges, no filler, no announcers",
	F4: "Plain words a neighbour uses",
	G1: "The figure appears as the record writes it, once",
	G2: "Scale comes from the record or not at all",
	G3: "The vote is given when the record gives it",
	G4: "A sum with no stated amount says so",
};

/**
 * What a check's evidence line reports, by the wording the check writes it
 * in. The source side of a finding (the figure it rounds, the roll call's
 * counts, the ledger title) is left out.
 */
const FINDINGS: readonly { says: RegExp; finding: string }[] = [
	{ says: /" is in no source: "/, finding: "is in no document or transcript" },
	{ says: /" rounds "/, finding: "rounds a figure the record writes exactly" },
	{
		says: /" is also written in full: "/,
		finding: "is written two ways",
	},
	{
		says: /" disagrees with the roll call, /,
		finding: "disagrees with the roll call the documents record",
	},
	{
		says: /" cannot be counted from the record: "/,
		finding: "cannot be counted from the record",
	},
	{
		says: /", whose amount the record does not state: "/,
		finding: "is given for a decision whose amount the record does not state",
	},
];

function quotedSpans(line: string): string[] {
	return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** One evidence line as feedback: the draft text it quotes, and its finding. */
function feedbackOf(id: CheckId, line: string, draftText: string): Feedback {
	const inDraft = quotedSpans(line).filter((span) => draftText.includes(span));
	if (draftText.includes(line)) inDraft.push(line);
	const byLength = [...inDraft].sort((a, b) => b.length - a.length);
	const quote = byLength[0] ?? "";
	const subject = byLength.length > 1 ? byLength.at(-1) : undefined;
	const known = FINDINGS.find(({ says }) => says.test(line));
	const finding =
		known !== undefined && subject !== undefined
			? `"${subject}" ${known.finding}`
			: RULES[id];
	return { checkId: id, quote, finding };
}

/**
 * Feedback for the writing call on a draft's failed checks: failed and
 * unchecked gates, then failed style checks, one item per line of evidence.
 * It quotes the draft and names the rule broken; it never says what to write
 * instead.
 */
export function feedbackFrom(
	report: CheckReport,
	draft: WriteUp,
): readonly Feedback[] {
	const draftText = [...draft.highlights, draft.prose].join("\n");
	const gates = GATE_IDS.flatMap((id) => {
		const verdict = report.verdicts[id];
		if (verdict === undefined || verdict.outcome === "pass") return [];
		const lines =
			verdict.outcome === "fail" ? verdict.evidence : verdict.reason;
		return lines.split("\n").map((line) => feedbackOf(id, line, draftText));
	});
	const styles = STYLE_IDS.flatMap((id) => {
		const verdict = report.verdicts[id];
		if (verdict?.outcome !== "fail") return [];
		return verdict.evidence
			.split("\n")
			.map((line) => feedbackOf(id, line, draftText));
	});
	return [...gates, ...styles];
}
