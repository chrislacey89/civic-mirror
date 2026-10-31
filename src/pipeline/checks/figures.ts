import {
	figuresIn,
	statesFigure,
	type WrittenFigure,
} from "#/pipeline/figureMatch.ts";
import { sourceTextOfKind } from "#/pipeline/sources.ts";
import type { CheckContext, CodeCheck, Verdict, WriteUp } from "./types.ts";

/** A pair of counts: "4-1", "5–0". */
const COUNT_PAIR =
	/(?<![\d–-])(?<yes>\d{1,2})\s?[–-]\s?(?<no>\d{1,2})(?![\d–-]|,\d)/g;

/**
 * A stated vote count: "unanimously", or a pair of counts with a vote word
 * just before it ("voted 4-1", "passed 2-1") or "vote" just after ("a 3-2
 * vote"). A pair without one is a range ("5-6 buildings", "January 19-25").
 */
const TALLY =
	/\bunanimous(?:ly)?\b|(?<=\b(?:vot(?:e|ed|es|ing)|pass(?:ed|es)?|carri(?:ed|es)|fail(?:ed|s)?|approv(?:ed|es)|adopt(?:ed|s)|defeat(?:ed|s)?|by)\s+(?:(?!(?:for|from|between|about|than|at)\b)\w+\s+){0,2})(?<yes>\d{1,2})\s?[–-]\s?(?<no>\d{1,2})(?![\d–-]|,\d)|(?<![\d–-])(?<yesBefore>\d{1,2})\s?[–-]\s?(?<noBefore>\d{1,2})(?=\s+vote)/gi;

const DAY = String.raw`(?:[12]\d|3[01]|0?[1-9])`;

/**
 * A day after a month name: "March 23", "January 19-25". It is a date only
 * where the day is 1-31, is not followed by a plural noun ("In May 25
 * employees were laid off" counts people), and a range runs forward ("May 3-2"
 * is a tally; see blanked). A word the day can precede ("May 27 the board
 * met", "May 27 was") is not a plural noun. Anything else is left to be read.
 */
const MONTH_DAY = new RegExp(
	String.raw`\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?<from>${DAY})(?:\s?[–-]\s?(?<to>${DAY}))?(?:st|nd|rd|th)?\b(?!,\d|\.\d|\s?(?:million|thousand|billion|percent|%)|\s+(?!(?:was|is|has|as|this|his|us|plus)\b)[a-z]+s\b)`,
	"g",
);

/**
 * Numbers that are neither figures nor tallies: phone numbers, ordinance and
 * resolution numbers, tax-code sections ("501(c)(3)"), street addresses,
 * clock times, dates and bare years. A day after a month name ("March 23",
 * "January 19-25") is a date whether or not the record writes it that way.
 */
const NOT_COUNTS: readonly RegExp[] = [
	/\b\d+\([a-z]\)(?:\(\d+\))?/gi,
	/\(?\b\d{3}\)?[\s.-]\d{3}[.-]\d{4}\b/g,
	/\b(?:ordinances?|resolutions?|ord\.|res\.)\s*(?:no\.?\s*)?#?\s*\d[\d-]*/gi,
	/\b\d+\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct|Pike|Highway|Hwy|Place|Pl)\b/g,
	/\b\d{1,2}:\d{2}\b/g,
	/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
	MONTH_DAY,
	/(?<![\d$,.])(?:19|20)\d{2}(?![\d,%]|\.\d|\s?(?:million|thousand|billion|percent))/g,
];

/** What is blanked before figures are read: the above, and pairs of counts. */
const NOT_FIGURES: readonly RegExp[] = [...NOT_COUNTS, COUNT_PAIR];

function blanked(text: string, patterns: readonly RegExp[]): string {
	return patterns.reduce(
		(current, pattern) =>
			current.replace(pattern, (match, ...rest) => {
				const groups = rest.at(-1);
				// A month-day range that runs backward ("May 3-2") is a tally.
				const backward =
					pattern === MONTH_DAY &&
					groups?.to !== undefined &&
					Number(groups.to) <= Number(groups.from);
				return backward ? match : " ".repeat(match.length);
			}),
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
		[...blanked(sentence, NOT_COUNTS).matchAll(TALLY)].map((match) => {
			const yes = match.groups?.yes ?? match.groups?.yesBefore;
			const no = match.groups?.no ?? match.groups?.noBefore;
			return {
				text: match[0],
				yes: yes === undefined ? null : Number(yes),
				no: no === undefined ? 0 : Number(no),
				sentence,
				passage,
			};
		}),
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
 * agrees with the record. The roll calls on the tally's motion are found by
 * its paragraph, since a short sentence ("The council voted 5-0.") names no
 * motion; the tally agrees if any of them counts to it. Without one, a tally
 * a source states passes, and any other cannot be checked.
 */
function tallyFinding(
	tally: StatedTally,
	ctx: CheckContext,
): { fail: string } | { unchecked: string } | null {
	const minutes = sourceTextOfKind(ctx.input.sources, "documents");
	const counted = rollCallsOn(minutes, tally.passage);
	if (counted.length > 0) {
		if (
			counted.some(
				(rollCall) =>
					rollCall.no === tally.no &&
					(tally.yes === null || rollCall.yes === tally.yes),
			)
		) {
			return null;
		}
		const counts = [
			...new Set(
				counted.map((rollCall) => `${rollCall.yes} yes and ${rollCall.no} no`),
			),
		].join(", or ");
		return {
			fail: `"${tally.text}" disagrees with the roll call, ${counts}: "${tally.sentence}"`,
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

/**
 * The head of a roll call: "Roll call vote:", "Roll call for the original
 * motion:". The attendance roll ("Roll Call: Members present") matches too
 * and counts no votes.
 */
const ROLL_CALL_START =
	/roll\s+call(?:\s+vote)?(?:\s+(?:for|on)\b[^:;.]{0,60})?\s*:/gi;

const ROLL_CALL_END =
	/motion\s+(?:carries|carried|passes|passed|fails|failed|dies|died)|roll\s+call/i;

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
	/** The text since the previous roll call, before any shared motion. */
	own: string;
};

/**
 * Each roll call in the minutes that records a vote, counted up to "Motion
 * carries" (or the next roll call): "Name — yes" and "Name — aye" are yes
 * votes, "Name — no" and "Name — nay" no votes; an abstention is neither.
 * Its motion is the text since the previous roll call ended. A roll call
 * that follows another with almost nothing between, as the vote on a motion
 * follows the vote on its amendment, shares the previous one's motion.
 */
function rollCallsIn(documentsText: string): RollCall[] {
	const rollCalls: RollCall[] = [];
	let previousEnd = 0;
	for (const match of documentsText.matchAll(ROLL_CALL_START)) {
		const after = match.index + match[0].length;
		const rest = documentsText.slice(after, after + ROLL_CALL_LENGTH);
		const end = rest.search(ROLL_CALL_END);
		const votes = end === -1 ? rest : rest.slice(0, end);
		const between = documentsText.slice(
			Math.max(previousEnd, match.index - MOTION_CONTEXT_LENGTH),
			match.index,
		);
		const yes = (votes.match(/[—–-]\s*(?:yes|aye)\b/gi) ?? []).length;
		const no = (votes.match(/[—–-]\s*(?:no|nay)\b/gi) ?? []).length;
		if (yes + no === 0) continue;
		previousEnd = after + votes.length;
		const previous = rollCalls.at(-1);
		const motion =
			namingWords(between).size < 2 && previous !== undefined
				? `${previous.motion} ${between}`
				: between;
		rollCalls.push({ yes, no, motion, own: between });
	}
	return rollCalls;
}

/**
 * The roll calls on `motion`: those whose preceding text shares the most
 * naming words with it, at least two. Where there are three or more roll
 * calls, words in the text of most of them (members' names, "seconded") name
 * none of them and are not counted; a shared motion is counted once.
 */
function rollCallsOn(documentsText: string, motion: string): RollCall[] {
	const rollCalls = rollCallsIn(documentsText);
	const motionWords = rollCalls.map((rollCall) => namingWords(rollCall.motion));
	const ownWords = rollCalls.map((rollCall) => namingWords(rollCall.own));
	const common = new Set(
		[...new Set(ownWords.flatMap((words) => [...words]))].filter(
			(word) =>
				rollCalls.length > 2 &&
				ownWords.filter((words) => words.has(word)).length >
					rollCalls.length / 2,
		),
	);
	const wanted = namingWords(motion);
	const scores = motionWords.map(
		(words) =>
			[...words].filter((word) => wanted.has(word) && !common.has(word)).length,
	);
	const best = Math.max(0, ...scores);
	if (best < 2) return [];
	return rollCalls.filter((_, index) => scores[index] === best);
}

/**
 * The yes and no count of the roll call on `motion`, found as
 * {@link rollCallsOn} finds it. Null when there is none, or when the roll
 * calls that match best count differently.
 */
export function rollCallTally(
	documentsText: string,
	motion: string,
): { yes: number; no: number } | null {
	const counts = new Map(
		rollCallsOn(documentsText, motion).map(({ yes, no }) => [
			`${yes}-${no}`,
			{ yes, no },
		]),
	);
	return counts.size === 1 ? [...counts.values()][0] : null;
}

/** Wording that says a sum is not in the record. */
const SAYS_UNSTATED =
	/\b(?:no total|not (?:stated|read|given|announced)|unstated|did not (?:state|give|read|announce))\b/i;

/**
 * G4: a sentence that names a ledger decision whose amount is "not stated"
 * (two naming words of its title) and gives a dollar figure no source
 * writes, without saying the sum is unstated.
 */
function unstatedSums(
	ungrounded: readonly StatedFigure[],
	ctx: CheckContext,
): string[] {
	const unstated = ctx.ledger.filter(
		(decision) => !statesFigure(decision.originalAmount),
	);
	return ungrounded.flatMap(({ figure, sentence }) => {
		if (!(figure.hasDollarSign || figure.hasScale)) return [];
		if (SAYS_UNSTATED.test(sentence)) return [];
		const words = namingWords(sentence);
		const decision = unstated.find(
			(candidate) =>
				[...namingWords(candidate.title)].filter((word) => words.has(word))
					.length >= 2,
		);
		return decision === undefined
			? []
			: [
					`"${figure.text}" is given for "${decision.title}", whose amount the record does not state: "${sentence}"`,
				];
	});
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
 * How many distinct figures the draft states that a source writes. A writer
 * can pass A1 by dropping figures, so this is kept per round to show it.
 */
export function groundedFigureCount(draft: WriteUp, ctx: CheckContext): number {
	const grounded = sourceValues(ctx);
	return new Set(
		statedFigures(draft)
			.map(({ figure }) => figure.value)
			.filter((value) => grounded.has(value)),
	).size;
}

/**
 * What A1 means for a ledger figure, as the writing prompt and its FEEDBACK
 * block tell it to the writer. Both interpolate this, so the writer is told
 * the rule the check holds it to: A1 compares figures by value, so a numeral
 * punctuated differently still grounds it.
 */
export const LEDGER_FIGURE_RULE =
	'A figure in LEDGER is kept in the prose only if DOCUMENTS or TRANSCRIPT writes the same amount as a clear numeral, even if punctuated differently ("$41.700.00" for $41,700), and is left out otherwise, including when a source gives it only in words or inside garbled text.';

/**
 * A1 for figures and votes, G1 and G4. Every figure in the headline,
 * highlights and prose must be written as a whole token in the documents or
 * the transcript; the ledger is not a source (LEDGER_FIGURE_RULE).
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
			G4: failOrPass(unstatedSums(ungrounded, ctx)),
		};
	},
};
