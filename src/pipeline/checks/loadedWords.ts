import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import type { CodeCheck } from "./types.ts";

/**
 * Rubric § A2: words and phrases that carry a judgment the record does not
 * make. Each matches as whole words, case-insensitive, and every form of a
 * verb is listed because headlines are present tense ("slams", "sparks
 * debate"). "Claims" is left out: the noun ("paid its claims") is plain. A word with a plain
 * use is listed only in the phrases where it judges: "heated debate", not
 * the heated pool; "finally approved", not the "Finally," that starts a
 * last item. "Only" judges or counts depending on the sentence, so it is
 * left to the judge.
 */
export const LOADED_WORDS: readonly string[] = [
	"slammed",
	"slams",
	"slam",
	"slamming",
	"sparked debate",
	"sparks debate",
	"spark debate",
	"sparking debate",
	"sparked controversy",
	"sparks controversy",
	"spark controversy",
	"sparking controversy",
	"controversial",
	"heated debate",
	"heated debates",
	"heated discussion",
	"heated discussions",
	"heated exchange",
	"heated exchanges",
	"finally approved",
	"finally approves",
	"finally approve",
	"finally approving",
	"finally passed",
	"finally passes",
	"finally pass",
	"finally passing",
	"finally adopted",
	"finally adopts",
	"finally adopt",
	"finally adopting",
	"merely",
	"sadly",
	"admitted",
	"admits",
	"admit",
	"admitting",
	"claimed",
	"claiming",
	"insisted",
	"insists",
	"insist",
	"insisting",
	"pointed out",
	"points out",
	"point out",
	"pointing out",
];

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MATCHERS = LOADED_WORDS.map((phrase) => ({
	phrase,
	pattern: new RegExp(
		String.raw`(?<![\p{L}])${escaped(phrase)}(?![\p{L}])`,
		"iu",
	),
}));

/**
 * A2, the part a list can settle: each listed word fails, quoting the word as
 * the draft writes it and its sentence. A pass does not clear motive or judgment the list cannot name.
 */
export const loadedWordsCheck: CodeCheck = {
	owns: ["A2"],
	run: (draft) => {
		const failures = passagesOf(draft)
			.flatMap(sentencesOf)
			.flatMap((sentence) =>
				MATCHERS.flatMap(({ pattern }) => {
					const match = sentence.match(pattern);
					return match === null
						? []
						: [`loaded word "${match[0]}": "${sentence}"`];
				}),
			);
		return { A2: failOrPass(failures) };
	},
};
