import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import { extractNames, namedIn, onOfficialsList, TITLES } from "./names.ts";
import type { CheckContext, CodeCheck } from "./types.ts";

/**
 * What may sit on a heading line beside its words: OCR noise before it
 * ("Nn Council Comments", "1 New Business"), a time limit after it, and
 * "None" where no one spoke.
 */
const BEFORE_HEADING = String.raw`^(?:[^\p{L}\n]{0,4}|\p{L}{1,2} |\d{1,2}[.)]? )?`;
const AFTER_HEADING = String.raw`(?:[^\p{L}\n]*(?:none|\([^)]*\))?[^\p{L}\n]*)?$`;

function heading(names: readonly string[]): RegExp {
	return new RegExp(
		`${BEFORE_HEADING}(?:${names.join("|")})${AFTER_HEADING}`,
		"iu",
	);
}

/** A line that heads the public-comment section, as the minutes print it. */
const SECTION_HEADING = heading([
	"privilege of the floor",
	"public comments?",
	"citizens?'? comments?",
	"public input",
	"public participation",
	"comments? from the public",
]);

/**
 * A line that heads the section after public comment. Any agenda heading
 * will do: a section no heading closes runs to the end of the text.
 */
const NEXT_HEADING = heading([
	"supervisor comments",
	"council comments",
	"commissioner comments",
	"board comments",
	"staff comments",
	"adjournment",
	"new business",
	"old business",
	"unfinished business",
	"reports?",
	"department reports?",
	"staff reports?",
	"public hearings?",
	"resolutions?",
	"ordinances?",
	"consent agenda",
	"action items",
	"announcements",
	"executive session",
	"approval of minutes",
	"next meeting",
]);

/**
 * The public-comment section of a document's text: the lines after its
 * heading, up to the next heading. Empty when the heading says no one spoke;
 * null when no heading marks one.
 */
export function publicCommentSection(documentsText: string): string | null {
	const lines = documentsText.split(/\r?\n/).map((line) => line.trim());
	const start = lines.findIndex((line) => SECTION_HEADING.test(line));
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => NEXT_HEADING.test(line));
	return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

/**
 * The public-comment sections of a meeting's documents, joined; null when
 * no document marks one.
 */
function publicCommentOf(ctx: CheckContext): string | null {
	const sections = ctx.input.sources
		.filter((source) => source.kind === "documents")
		.map((source) => publicCommentSection(source.text))
		.filter((section) => section !== null);
	return sections.length === 0 ? null : sections.join("\n");
}

/**
 * Title words that give a person a role. An honorific gives none, and the
 * rubric reads a business owner at public comment as a resident.
 */
const ROLE_WORDS: ReadonlySet<string> = new Set(
	[...TITLES].filter(
		(word) => !["mr", "mrs", "ms", "dr", "owner", "resident"].includes(word),
	),
);

/** Words an organisation's name ends with or contains, never a street's. */
const ORG_WORDS: ReadonlySet<string> = new Set(
	"agency associates association authority bank board bureau chamber church city co college commission committee company construction consulting contractors corp corporation council county department development district engineering fire foundation group hospital inc institute legion library llc llp ltd office partners police school schools services state town township university utilities utility".split(
		" ",
	),
);

/** Lowercased words, with punctuation gone. */
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((word) => word !== "");
}

function hasAny(text: string, words: ReadonlySet<string>): boolean {
	return wordsOf(text).some((word) => words.has(word));
}

/** An organisation written after of, with, from or representing. */
const ORG_AFTER =
	/^,?\s*(?:of|with|from|for|representing|on behalf of)\s+((?:the\s+)?(?:\p{Lu}[\p{L}&.'’-]*\s*){1,6})/u;

/**
 * Whether `text` writes a role or office beside `name`: a title in the three
 * words before it ("County Commissioner Ada Lovelace"), a clause after it
 * with a title in it ("Ada Lovelace, Highway Director,"), or an organisation
 * after it ("Ada Lovelace of Elm Engineering"). An address is neither.
 */
function hasRoleBeside(name: string, text: string): boolean {
	const flat = text.replace(/\s+/g, " ");
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const occurrence = new RegExp(
		String.raw`((?:[^\s.;:!?]+ ){0,3})${escaped}(?![\p{L}])`,
		"gu",
	);
	return [...flat.matchAll(occurrence)].some((match) => {
		const after = flat.slice(match.index + match[0].length);
		const clause = after.match(/^,\s*([^,.;]{1,80})/);
		return (
			hasAny(match[1] ?? "", ROLE_WORDS) ||
			/^,\s*(?:representing|on behalf of)\b/i.test(after) ||
			(clause !== null && hasAny(clause[1] ?? "", ROLE_WORDS)) ||
			hasAny(after.match(ORG_AFTER)?.[1] ?? "", ORG_WORDS)
		);
	});
}

/**
 * The sentence of `passage` that names `name`, with the name replaced by
 * "[name]" and the offset the name had, so the evidence shows which sentence
 * without repeating who.
 */
function redacted(name: string, passage: string): string {
	const sentence =
		sentencesOf(passage).find((s) => s.includes(name)) ?? passage;
	const at = sentence.indexOf(name);
	return `"${sentence.replaceAll(name, "[name]")}" (name at ${at})`;
}

/**
 * A5. On a meeting whose minutes mark public comment, a name the prose takes
 * from inside that section is a resident's, unless it is on the officials
 * list or the section writes a role or office beside it.
 */
export const publicCommentCheck: CodeCheck = {
	owns: ["A5"],
	run: (draft, ctx) => {
		const section = publicCommentOf(ctx);
		const failures = passagesOf(draft).flatMap((passage) =>
			extractNames(passage)
				.filter(
					(name) =>
						!onOfficialsList(name, ctx.officials) &&
						section !== null &&
						namedIn(name, section) &&
						!hasRoleBeside(name, section),
				)
				.map(
					(name) =>
						`a resident at public comment is named: ${redacted(name, passage)}`,
				),
		);
		return { A5: failOrPass(failures) };
	},
};
