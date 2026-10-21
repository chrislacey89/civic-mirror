import { figuresIn, type WrittenFigure } from "#/pipeline/figureMatch.ts";
import { sourceTextOfKind } from "#/pipeline/sources.ts";
import type { CheckContext, CodeCheck, Verdict, WriteUp } from "./types.ts";

/** A stated vote count: "4-1", "5–0", or "unanimously". */
const TALLY =
	/(?<![\d–-])(?<yes>\d{1,2})\s?[–-]\s?(?<no>\d{1,2})(?![\d–-]|,\d)|\bunanimous(?:ly)?\b/gi;

/**
 * Numbers that are not figures: phone numbers, ordinance and resolution
 * numbers, street addresses, clock times, numeric dates and bare years.
 * Each is blanked before figures are read.
 */
const NOT_FIGURES: readonly RegExp[] = [
	/\(?\b\d{3}\)?[\s.-]\d{3}[.-]\d{4}\b/g,
	/\b(?:ordinances?|resolutions?|ord\.|res\.)\s*(?:no\.?\s*)?#?\s*\d[\d-]*/gi,
	/\b\d+\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct|Pike|Highway|Hwy|Place|Pl)\b/g,
	/\b\d{1,2}:\d{2}\b/g,
	/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
	/(?<![\d$,.])(?:19|20)\d{2}(?![\d,%]|\.\d|\s?(?:million|thousand|billion|percent))/g,
	TALLY,
];

function blanked(text: string, patterns: readonly RegExp[]): string {
	return patterns.reduce(
		(current, pattern) =>
			current.replace(pattern, (match) => " ".repeat(match.length)),
		text,
	);
}

/**
 * The figures `text` writes as whole tokens. A number joined to letters
 * ("JD460") or to another number ("fpaa-215.10") is a garbled token, and a
 * figure inside one is not read; an ordinal suffix ("40th") is allowed.
 */
function wholeFigures(text: string): WrittenFigure[] {
	return figuresIn(text).filter((figure) => {
		const before = text[figure.index - 1] ?? " ";
		const after = text.slice(figure.index + figure.text.length);
		return (
			!/[\p{L}\d.\-/]/u.test(before) &&
			(!/^[\p{L}\d]/u.test(after) || /^(?:st|nd|rd|th)\b/i.test(after))
		);
	});
}

/** A passage's sentences. A period after a common abbreviation ends none. */
function sentencesOf(passage: string): string[] {
	return passage
		.split(/(?<!\b(?:No|Nos|Mr|Mrs|Ms|Dr|St|Ord|Res|Inc|Co|vs)\.)(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== "");
}

/** Each highlight and each prose paragraph. */
function passagesOf(draft: WriteUp): string[] {
	return [...draft.highlights, ...draft.prose.split(/\n\s*\n/)]
		.map((passage) => passage.trim())
		.filter((passage) => passage !== "");
}

type Sentence = { sentence: string; passage: string };

function sentencesOfDraft(draft: WriteUp): Sentence[] {
	return passagesOf(draft).flatMap((passage) =>
		sentencesOf(passage).map((sentence) => ({ sentence, passage })),
	);
}

type StatedFigure = { figure: WrittenFigure; sentence: string };

function statedFigures(draft: WriteUp): StatedFigure[] {
	return sentencesOfDraft(draft).flatMap(({ sentence }) =>
		wholeFigures(blanked(sentence, NOT_FIGURES)).map((figure) => ({
			figure,
			sentence,
		})),
	);
}

/** A tally the prose states; `no` is 0 and `yes` null for "unanimously". */
type StatedTally = {
	text: string;
	yes: number | null;
	no: number;
	sentence: string;
	passage: string;
};

function statedTallies(draft: WriteUp): StatedTally[] {
	return sentencesOfDraft(draft).flatMap(({ sentence, passage }) =>
		[...sentence.matchAll(TALLY)].map((match) => ({
			text: match[0],
			yes: match.groups?.yes === undefined ? null : Number(match.groups.yes),
			no: match.groups?.no === undefined ? 0 : Number(match.groups.no),
			sentence,
			passage,
		})),
	);
}

/** Whether a source states the tally itself: "4-1", "4 to 1", "unanimous". */
function statesTally(text: string, tally: StatedTally): boolean {
	if (tally.yes === null) return /\bunanimous/i.test(text);
	return new RegExp(
		`(?<![\\d–-])${tally.yes}\\s?(?:[–-]|to)\\s?${tally.no}(?![\\d–-]|,\\d)`,
	).test(text);
}

/**
 * A failure line, or why the tally could not be checked, or null when it
 * agrees with the record. The roll call on the tally's motion is found by
 * its sentence, then by its paragraph. Without one, a tally a source states
 * passes, and any other cannot be checked.
 */
function tallyFinding(
	tally: StatedTally,
	ctx: CheckContext,
): { fail: string } | { unchecked: string } | null {
	const minutes = sourceTextOfKind(ctx.input.sources, "documents");
	const counted =
		rollCallTally(minutes, tally.sentence) ??
		rollCallTally(minutes, tally.passage);
	if (counted !== null) {
		const agrees =
			counted.no === tally.no &&
			(tally.yes === null || counted.yes === tally.yes);
		return agrees
			? null
			: {
					fail: `"${tally.text}" disagrees with the roll call, ${counted.yes} yes and ${counted.no} no: "${tally.sentence}"`,
				};
	}
	if (ctx.input.sources.some((source) => statesTally(source.text, tally))) {
		return null;
	}
	return {
		unchecked: `"${tally.text}" cannot be counted from the record: "${tally.sentence}"`,
	};
}

const SPELLED_NUMBERS: Readonly<Record<string, bigint>> = {
	zero: 0n,
	one: 1n,
	two: 2n,
	three: 3n,
	four: 4n,
	five: 5n,
	six: 6n,
	seven: 7n,
	eight: 8n,
	nine: 9n,
	ten: 10n,
	eleven: 11n,
	twelve: 12n,
	thirteen: 13n,
	fourteen: 14n,
	fifteen: 15n,
	sixteen: 16n,
	seventeen: 17n,
	eighteen: 18n,
	nineteen: 19n,
	twenty: 20n,
	a: 1n,
};

const SPELLED_SCALES: Readonly<Record<string, bigint>> = {
	thousand: 1_000n,
	million: 1_000_000n,
	billion: 1_000_000_000n,
};

/**
 * The values of the numbers `text` spells out, in cents: "five", and "a
 * million" or "two million". A lone "a" is not a number.
 */
function spelledValues(text: string): bigint[] {
	return [
		...text.matchAll(
			/\b(?<number>[a-z]+)(?:\s+(?<scale>thousand|million|billion))?\b/gi,
		),
	].flatMap((match) => {
		const number = SPELLED_NUMBERS[match.groups?.number?.toLowerCase() ?? ""];
		const scale = match.groups?.scale?.toLowerCase();
		if (number === undefined) return [];
		if (scale === undefined) {
			return match.groups?.number?.toLowerCase() === "a" ? [] : [number * 100n];
		}
		return [number * SPELLED_SCALES[scale] * 100n];
	});
}

/**
 * The value of every figure the sources write as a whole token, or spell
 * out.
 */
function sourceValues(ctx: CheckContext): Set<bigint> {
	return new Set(
		ctx.input.sources.flatMap((source) => [
			...wholeFigures(source.text).map((figure) => figure.value),
			...spelledValues(source.text),
		]),
	);
}

/** Every figure the sources write as a whole token. */
function sourceFigures(ctx: CheckContext): WrittenFigure[] {
	return ctx.input.sources.flatMap((source) => wholeFigures(source.text));
}

/**
 * Whether `stated` is `source` written less precisely: a different value
 * within one step of how `stated` is written, as "$139,775" is of
 * "$139,775.03" and "$2.2 million" of "$2,213,400".
 */
function rounds(stated: WrittenFigure, source: WrittenFigure): boolean {
	const gap =
		stated.value > source.value
			? stated.value - source.value
			: source.value - stated.value;
	return gap !== 0n && gap < stated.precision;
}

/** One sum written both with a scale word and in full ("$2.2 million", "$2,200,000"). */
function writtenTwoWays(stated: readonly StatedFigure[]): string[] {
	return stated.flatMap(({ figure, sentence }) =>
		figure.hasScale &&
		stated.some(
			(other) => !other.figure.hasScale && other.figure.value === figure.value,
		)
			? [`"${figure.text}" is also written in full: "${sentence}"`]
			: [],
	);
}

/** How far before a roll call its motion is looked for. */
const MOTION_CONTEXT_LENGTH = 600;

/** How far after "Roll call vote" its votes are counted, at most. */
const ROLL_CALL_LENGTH = 600;

const ROLL_CALL_START = /roll\s+call\s+vote/gi;

const ROLL_CALL_END =
	/motion\s+(?:carries|carried|passes|passed|fails|failed|dies|died)|roll\s+call\s+vote/i;

/** Words in most motions and votes, which name no motion in particular. */
const VOTE_WORDS: ReadonlySet<string> = new Set([
	"about",
	"after",
	"also",
	"approval",
	"approve",
	"approved",
	"been",
	"call",
	"carries",
	"council",
	"from",
	"have",
	"made",
	"member",
	"members",
	"motion",
	"moved",
	"roll",
	"second",
	"seconded",
	"that",
	"their",
	"there",
	"they",
	"this",
	"town",
	"vote",
	"voted",
	"votes",
	"were",
	"which",
	"will",
	"with",
	"would",
]);

/**
 * The words of `text` that can name a motion, each cut to its first five
 * letters so "creating" and "created" agree.
 */
function namingWords(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
			.filter((word) => !VOTE_WORDS.has(word))
			.map((word) => word.slice(0, 5)),
	);
}

type RollCall = {
	yes: number;
	no: number;
	/** The text before the roll call, where its motion is stated. */
	motion: string;
};

/**
 * Each "Roll call vote" in the minutes, counted up to "Motion carries" (or
 * the next roll call): "Name — yes" and "Name — aye" are yes votes, "Name —
 * no" and "Name — nay" no votes; an abstention is neither.
 */
function rollCallsIn(documentsText: string): RollCall[] {
	let previousEnd = 0;
	return [...documentsText.matchAll(ROLL_CALL_START)].map((match) => {
		const start = match.index;
		const rest = documentsText.slice(
			start + match[0].length,
			start + match[0].length + ROLL_CALL_LENGTH,
		);
		const end = rest.search(ROLL_CALL_END);
		const votes = end === -1 ? rest : rest.slice(0, end);
		const motion = documentsText.slice(
			Math.max(previousEnd, start - MOTION_CONTEXT_LENGTH),
			start,
		);
		previousEnd = start + match[0].length + (end === -1 ? 0 : end);
		return {
			yes: (votes.match(/[—–-]\s*(?:yes|aye)\b/gi) ?? []).length,
			no: (votes.match(/[—–-]\s*(?:no|nay)\b/gi) ?? []).length,
			motion,
		};
	});
}

/**
 * The yes and no count of the roll call on `motion`: the roll call whose
 * preceding text shares the most naming words with it, at least two. Words
 * before most of the roll calls (members' names, "seconded") name none of
 * them and are not counted. Null when no roll call shares two words, or when
 * roll calls with different counts share the most.
 */
export function rollCallTally(
	documentsText: string,
	motion: string,
): { yes: number; no: number } | null {
	const rollCalls = rollCallsIn(documentsText);
	const motionWords = rollCalls.map((rollCall) => namingWords(rollCall.motion));
	const common = new Set(
		[...new Set(motionWords.flatMap((words) => [...words]))].filter(
			(word) =>
				rollCalls.length > 1 &&
				motionWords.filter((words) => words.has(word)).length >
					rollCalls.length / 2,
		),
	);
	const wanted = namingWords(motion);
	const scores = motionWords.map(
		(words) =>
			[...words].filter((word) => wanted.has(word) && !common.has(word)).length,
	);
	const best = Math.max(0, ...scores);
	if (best < 2) return null;
	const tallies = new Set(
		rollCalls
			.filter((_, index) => scores[index] === best)
			.map((rollCall) => `${rollCall.yes}-${rollCall.no}`),
	);
	if (tallies.size !== 1) return null;
	const chosen = rollCalls[scores.indexOf(best)];
	return { yes: chosen.yes, no: chosen.no };
}

function failOrPass(
	failures: readonly string[],
	unchecked: readonly string[] = [],
): Verdict {
	const unique = [...new Set(failures)];
	if (unique.length > 0) {
		return { outcome: "fail", evidence: unique.join("\n") };
	}
	return unchecked.length === 0
		? { outcome: "pass" }
		: { outcome: "unchecked", reason: [...new Set(unchecked)].join("\n") };
}

/**
 * A1 for figures and votes, G1 and G4. Every figure in the headline,
 * highlights and prose must be written as a whole token in the documents or
 * the transcript; the ledger is not a source.
 */
export const figuresCheck: CodeCheck = {
	owns: ["A1", "G1", "G4"],
	run: (draft, ctx) => {
		const grounded = sourceValues(ctx);
		const written = sourceFigures(ctx);
		const stated = statedFigures(draft);
		const ungrounded = stated.filter(
			({ figure }) => !grounded.has(figure.value),
		);
		const tallies = statedTallies(draft).map((tally) =>
			tallyFinding(tally, ctx),
		);
		return {
			A1: failOrPass(
				[
					...ungrounded.map(
						({ figure, sentence }) =>
							`"${figure.text}" is in no source: "${sentence}"`,
					),
					...tallies.flatMap((finding) =>
						finding !== null && "fail" in finding ? [finding.fail] : [],
					),
				],
				tallies.flatMap((finding) =>
					finding !== null && "unchecked" in finding ? [finding.unchecked] : [],
				),
			),
			G1: failOrPass([
				...ungrounded.flatMap(({ figure, sentence }) => {
					const rounded = written.find((source) => rounds(figure, source));
					return rounded === undefined
						? []
						: [`"${figure.text}" rounds "${rounded.text}": "${sentence}"`];
				}),
				...writtenTwoWays(stated),
			]),
			G4: { outcome: "pass" },
		};
	},
};
