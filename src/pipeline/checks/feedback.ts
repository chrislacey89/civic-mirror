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
	A1: "Every figure and vote is in a source, and every name is in a source or on the officials list",
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
 * counts, the ledger title) is left out. A finding is read after the quoted
 * subject, or whole when the line quotes no subject (`whole`).
 */
const FINDINGS: readonly { says: RegExp; finding: string; whole?: true }[] = [
	{
		says: /^a resident at public comment is named: "/,
		finding: "names a resident who spoke at public comment",
		whole: true,
	},
	{
		says: /^a name is on no officials list and has no role in the documents: "/,
		finding:
			"names a person who is on no officials list and has no role in the documents",
		whole: true,
	},
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

/** The blank an evidence line puts where it will not repeat a name. */
const BLANK = "[name]";

/**
 * What a blank stands for in the draft: one to four words that do not end
 * a sentence, a middle initial among them ("Ada B. Lovelace").
 */
const NAME_SHAPED = String.raw`(?:\p{Lu}\.|[^\s.!?]+)(?: (?:\p{Lu}\.|[^\s.!?]+)){0,3}?`;

/**
 * The quoted spans of an evidence line as the draft writes them. A span
 * with a name blanked out is read back from the draft, with the name in;
 * the writing call sees the draft anyway, and needs the sentence to revise.
 */
function quotedSpans(line: string, draftText: string): string[] {
	return [...line.matchAll(/"([^"]+)"/g)].flatMap((match) => {
		const span = match[1] ?? "";
		if (!span.includes(BLANK)) return [span];
		const pattern = span
			.split(BLANK)
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(NAME_SHAPED);
		const found = draftText.match(new RegExp(pattern, "u"));
		return found === null ? [] : [found[0]];
	});
}

/** One evidence line as feedback: the draft text it quotes, and its finding. */
function feedbackOf(id: CheckId, line: string, draftText: string): Feedback {
	const inDraft = quotedSpans(line, draftText).filter((span) =>
		draftText.includes(span),
	);
	if (draftText.includes(line)) inDraft.push(line);
	const byLength = [...inDraft].sort((a, b) => b.length - a.length);
	const quote = byLength[0] ?? "";
	const subject = byLength.length > 1 ? byLength.at(-1) : undefined;
	const known = FINDINGS.find(({ says }) => says.test(line));
	const finding =
		known === undefined
			? RULES[id]
			: known.whole
				? known.finding
				: subject !== undefined
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
