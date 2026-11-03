import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import type { CodeCheck } from "./types.ts";

/** A verb a write-up uses when it reports what a source says. */
const SAYS = `(?:says?|said|states?|stated|shows?|showed|notes?|noted|lists?|listed|records?|recorded|indicates?|indicated)`;

/**
 * Rubric § A3: what the write-up never says because it comes from how the
 * record was made, not from the meeting. Each is case-insensitive. The
 * minutes, the documents and the record are named in a meeting for other
 * reasons ("approved the minutes", "signed the documents"), so they match
 * only as a source being read from.
 */
export const ARTIFACT_PATTERNS: readonly RegExp[] = [
	/\bthe transcript\b/i,
	/\bthe (?:closed )?captions?\b/i,
	new RegExp(String.raw`\bthe (?:minutes|documents|record) ${SAYS}\b`, "i"),
	/\b(?:according to|per) the (?:minutes|documents|record)\b/i,
	/\[(?:inaudible|unintelligible|indiscernible|crosstalk|no audio|music|applause|laughter|silence)\]/i,
	/\bpage \d+ of \d+\b/i,
	/\[page \d+\]/i,
	/\bstated as\b/i,
	/\binternal contradiction\b/i,
	// Characters a scanned page leaves when OCR cannot read it.
	/[�■□▪]/u,
];

/** A3. No source artifacts leak: each match fails, quoting its sentence. */
export const artifactsCheck: CodeCheck = {
	owns: ["A3"],
	run: (draft) => {
		const failures = passagesOf(draft)
			.flatMap(sentencesOf)
			.flatMap((sentence) =>
				ARTIFACT_PATTERNS.flatMap((pattern) => {
					const match = sentence.match(pattern);
					return match === null
						? []
						: [`source artifact "${match[0]}": "${sentence}"`];
				}),
			);
		return { A3: failOrPass(failures) };
	},
};
