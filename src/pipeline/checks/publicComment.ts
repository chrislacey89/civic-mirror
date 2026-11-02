import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import { extractNames, namedIn, onOfficialsList, TITLES } from "./names.ts";
import type { CheckContext, CodeCheck, WriteUp } from "./types.ts";

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

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `name` as whole words: "Reed" is not in "Reedsville" or "Headdy". */
function wholeWords(name: string): RegExp {
	return new RegExp(
		String.raw`(?<![\p{L}\d])${escaped(name)}(?![\p{L}\d])`,
		"gu",
	);
}

/** Words a street's name ends with that are also surnames. */
const STREET_WORDS: ReadonlySet<string> = new Set(
	"avenue ave boulevard blvd circle court ct drive dr highway lane ln parkway pike place pl road rd street st trail way".split(
		" ",
	),
);

/**
 * Whether `name` is a street rather than a person: it ends in a street word
 * and `text` writes it after a place word ("on Lantern Lane"). A person with
 * such a surname is written after neither.
 */
function writtenAsPlace(name: string, text: string): boolean {
	const last = name.split(" ").at(-1)?.toLowerCase() ?? "";
	if (!STREET_WORDS.has(last)) return false;
	const afterPlaceWord = new RegExp(
		String.raw`\b(?:on|at|along|near|off|onto)\s+${escaped(name)}(?![\p{L}\d])`,
		"iu",
	);
	return afterPlaceWord.test(text.replace(/\s+/g, " "));
}

/**
 * The sentence of `passage` that names `name`, with every one of `names`
 * replaced by "[name]" and the offset `name` had, so the evidence shows
 * which sentence without repeating who. Whole names go first, longest
 * first, then each word of a full name on its own, so a surname alone or a
 * first name alone cannot be left behind.
 */
function redacted(
	name: string,
	passage: string,
	names: readonly string[],
): string {
	const sentence =
		sentencesOf(passage).find((s) => wholeWords(name).test(s)) ?? passage;
	const at = sentence.search(wholeWords(name));
	const words = names.flatMap((each) =>
		each.includes(" ") ? each.split(" ").filter((w) => w.length > 1) : [],
	);
	const blanked = [...new Set([...names, ...words])]
		.sort((a, b) => b.length - a.length)
		.reduce((text, each) => text.replace(wholeWords(each), "[name]"), sentence);
	return `"${blanked}" (name at ${at})`;
}

/**
 * Who a name in the draft is, as far as code can tell. On a meeting whose
 * minutes mark public comment, a name taken from inside that section is a
 * `resident` unless the section writes a role beside it; every other name
 * there is `resolved`. On any other meeting, a name is `resolved` by the
 * officials list or by a role the documents write beside it, and is
 * otherwise `unresolved`: code cannot tell a resident from a presenter.
 */
type Standing = "resident" | "resolved" | "unresolved";

function standingOf(name: string, ctx: CheckContext): Standing {
	if (onOfficialsList(name, ctx.officials)) return "resolved";
	const documents = ctx.input.sources
		.filter((source) => source.kind === "documents")
		.map((source) => source.text)
		.join("\n");
	if (writtenAsPlace(name, documents)) return "resolved";
	const section = publicCommentOf(ctx);
	if (section !== null) {
		return namedIn(name, section) && !hasRoleBeside(name, section)
			? "resident"
			: "resolved";
	}
	return hasRoleBeside(name, documents) ? "resolved" : "unresolved";
}

/** Each name in each passage of the draft, with its standing. */
function namesOf(
	draft: WriteUp,
	ctx: CheckContext,
): { name: string; passage: string; standing: Standing }[] {
	return passagesOf(draft).flatMap((passage) =>
		extractNames(passage).map((name) => ({
			name,
			passage,
			standing: standingOf(name, ctx),
		})),
	);
}

/**
 * The names the draft writes that code can neither clear nor fail for A5:
 * on no officials list, with no role in the documents, on a meeting whose
 * minutes do not mark public comment. The judge decides A5 for these.
 */
export function unresolvedNames(
	draft: WriteUp,
	ctx: CheckContext,
): readonly string[] {
	return [
		...new Set(
			namesOf(draft, ctx)
				.filter(({ standing }) => standing === "unresolved")
				.map(({ name }) => name),
		),
	];
}

/**
 * A5. Officials by name and role; the public by count. A resident named
 * from the public-comment section fails; a name code cannot resolve leaves
 * A5 unchecked, which holds the draft until a judge resolves it.
 */
export const publicCommentCheck: CodeCheck = {
	owns: ["A5"],
	run: (draft, ctx) => {
		const names = namesOf(draft, ctx);
		const flagged = names
			.filter(({ standing }) => standing !== "resolved")
			.map(({ name }) => name);
		const failures = names
			.filter(({ standing }) => standing === "resident")
			.map(
				({ name, passage }) =>
					`a resident at public comment is named: ${redacted(name, passage, flagged)}`,
			);
		const unresolved = names
			.filter(({ standing }) => standing === "unresolved")
			.map(
				({ name, passage }) =>
					`a name is on no officials list and has no role in the documents: ${redacted(name, passage, flagged)}`,
			);
		return { A5: failOrPass(failures, unresolved) };
	},
};
