import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import type { CodeCheck } from "./types.ts";

/**
 * Rubric § A2: words and phrases that carry a judgment the record does not
 * make. Each matches as whole words, case-insensitive. A word with a plain
 * use is listed only in the phrases where it judges: "heated debate", not
 * the heated pool; "finally approved", not the "Finally," that starts a
 * last item. "Only" judges or counts depending on the sentence, so it is
 * left to the judge.
 */
export const LOADED_WORDS: readonly string[] = [
	"slammed",
	"sparked debate",
	"sparked controversy",
	"controversial",
	"heated debate",
	"heated discussion",
	"heated exchange",
	"finally approved",
	"finally passed",
	"finally adopted",
	"merely",
	"sadly",
	"admitted",
	"claimed",
	"insisted",
	"pointed out",
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
 * A2, the part a list can settle: each listed word fails, quoting its
 * sentence. A pass does not clear motive or judgment the list cannot name.
 */
export const loadedWordsCheck: CodeCheck = {
	owns: ["A2"],
	run: (draft) => {
		const failures = passagesOf(draft)
			.flatMap(sentencesOf)
			.flatMap((sentence) =>
				MATCHERS.filter(({ pattern }) => pattern.test(sentence)).map(
					({ phrase }) => `loaded word "${phrase}": "${sentence}"`,
				),
			);
		return { A2: failOrPass(failures) };
	},
};
