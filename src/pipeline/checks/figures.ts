import { figuresIn, type WrittenFigure } from "#/pipeline/figureMatch.ts";
import type { CheckContext, CodeCheck, Verdict, WriteUp } from "./types.ts";

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

type StatedFigure = { figure: WrittenFigure; sentence: string };

function statedFigures(draft: WriteUp): StatedFigure[] {
	return passagesOf(draft).flatMap((passage) =>
		sentencesOf(passage).flatMap((sentence) =>
			wholeFigures(blanked(sentence, NOT_FIGURES)).map((figure) => ({
				figure,
				sentence,
			})),
		),
	);
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

function failOrPass(failures: readonly string[]): Verdict {
	const unique = [...new Set(failures)];
	return unique.length === 0
		? { outcome: "pass" }
		: { outcome: "fail", evidence: unique.join("\n") };
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
		const ungrounded = statedFigures(draft).filter(
			({ figure }) => !grounded.has(figure.value),
		);
		return {
			A1: failOrPass(
				ungrounded.map(
					({ figure, sentence }) =>
						`"${figure.text}" is in no source: "${sentence}"`,
				),
			),
			G1: { outcome: "pass" },
			G4: { outcome: "pass" },
		};
	},
};
