import {
	type CheckId,
	type CheckReport,
	type Feedback,
	GATE_IDS,
	STYLE_IDS,
	type WriteUp,
} from "./types.ts";

/**
 * Each check's rule as docs/writing-rubric.md states it, without its worked
 * examples or counts: a finding may carry nothing the draft does not.
 */
const RULES: Readonly<Record<CheckId, string>> = {
	A1: "every figure, name and vote is in a source",
	A2: "no opinion, no motive, no loaded words",
	A3: "no source artifacts leak",
	A4: "each sentence says what the source says",
	A5: "officials by name and role, the public by count",
	TRUNC: "the prose stops before a sentence ends",
	B1: "the headline is the one thing you would shout",
	B2: "the headline puts actor, verb and object first",
	B3: "the headline is short, with no clause after a comma",
	B4: "the headline names a concrete object",
	C1: "the lede adds a fact the headline did not give",
	C2: "the lede does not set the scene",
	C3: "the lede stands alone",
	C4: "the lede is short",
	D1: "importance order, not agenda order",
	D2: "meeting mechanics are cut",
	D3: "every item a resident could act on is kept, with its date",
	D4: "few highlights, one fact each",
	D5: "short paragraphs, one item each",
	D6: "length scales with the meeting",
	E1: "the body does the verb",
	E2: "verbs, not zombie nouns, on first mention",
	E3: "one thought per sentence",
	E4: "varied openings, steady names",
	F1: "no officialese",
	F2: "jargon is glossed or replaced on first use",
	F3: "no hedges, no filler, no announcers",
	F4: "plain words a neighbour uses",
	G1: "the figure appears as the record writes it, once",
	G2: "scale comes from the record or not at all",
	G3: "the vote is given when the record gives it",
	G4: "a sum with no stated amount says so",
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
