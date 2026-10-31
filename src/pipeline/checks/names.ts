import type { Official } from "#/pipeline/officials/types.ts";
import { failOrPass, passagesOf, sentencesOf } from "./figures.ts";
import type { CheckContext, CodeCheck } from "./types.ts";

/**
 * A capitalised word, with its apostrophes and hyphens: "O'Brien",
 * "Smith-Jones". A word in capitals ("MVH", "III") is not one.
 */
const WORD = String.raw`\p{Lu}[\p{L}'’-]*\p{Ll}`;

/**
 * A run of capitalised words on one line and in one sentence. An honorific's
 * period and a middle initial do not end it: "Dr. Ada Clerk", "Ada B. Clerk".
 */
const CAPITALISED_RUN = new RegExp(
	String.raw`(?<![\p{L}\d'’-])(?:(?:Mr|Mrs|Ms|Dr)\.? )?${WORD}(?: (?:\p{Lu}\. )?${WORD})*(?:['’]s)?(?![\p{L}\d])`,
	"gu",
);

/** Words that open a sentence and are no part of a name. */
const OPENERS: ReadonlySet<string> = new Set(
	"a about after also although an and as at attendees because before both but by despite during each everyone finally following for from further here however if in instead last later many meanwhile moreover next now of officials on once others over per residents several since some speakers staff than that the their then there these they this those through to under until when where while with within without yet".split(
		" ",
	),
);

/**
 * Words that open a date. Some are first names too, so one is dropped only
 * when a full name is left: "In May Ada Lovelace" but not "May Reed".
 */
const DATE_WORDS: ReadonlySet<string> = new Set(
	"january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(
		" ",
	),
);

/**
 * What follows a last name used alone in a sentence: the rubric's attribution
 * verbs and the ones the summaries use beside them. A capitalised word alone
 * may be anything, so it is read as a name only here or after a title.
 */
const ATTRIBUTION =
	/^ (?:added|asked|explained|moved|noted|presented|recommended|reported|said|stated|thanked|told|voted)\b/;

/**
 * Words that end a job title or rank. What comes after the last of them in a
 * run is the name, so "Richland Township Trustee Ada Clerk" gives "Ada Clerk",
 * "Utilities Billing Clerk" gives nothing, and "Chief Palmer" gives "Palmer".
 */
const TITLES: ReadonlySet<string> = new Set(
	"administrator applicant assistant attorney auditor captain chair chairman chairperson chairwoman chief clerk coach commissioner commissioners contractor coordinator councilman councilmember councilor councilperson councilwoman counsel deputy detective developer director dr engineer firefighter foreman inspector judge lieutenant lt manager marshal mayor member members mr mrs ms officer officers owner petitioner planner president principal prosecutor recorder representative resident secretary senator sergeant sgt sheriff specialist superintendent supervisor surveyor teacher tech technician treasurer trustee vice".split(
		" ",
	),
);

/**
 * Words no person's name carries: places, organisations, documents, programs
 * and things. A run with one of them names no one, so "Pay Policy" and
 * "Medical Reimbursement Agreement" are left alone. Words that are also
 * surnames (Hall, Park, Lane) are not here, so a run ending in one is still
 * read as a name, and a place with one passes by being in a source.
 */
const NOT_A_PERSON: ReadonlySet<string> = new Set(
	"academy account acquisition act administrative agency agreement alley amendment annexation appeal appeals association authority ave avenue bank blvd board boulevard budget building bureau business center centre chamber circle city claims club code college comments commerce commission committee community company construction consulting contract contractors control cooperative corporation council county creek crossing crossings ct cumulative department design development dist district division drive easement economic edgewood education electric ellettsville emergency energy engineering equipment estates exchange exteriors fairgrounds farm farms federal fence festival finance fire floor foundation fund funds funeral garage general girls government group growth heritage high highway homes hospital housing inc income indiana industrial institute insurance interlocal investigation legion library llc llp ltd lumber management manual map market matching medical memorial mitigation motor municipal national office old ordinance parks parkway partners paving pay petition phase pike place plan planning plat plaza police policy program project public quarter ranch recreation redevelopment reimbursement reorganization report reports reserve residential resolution resources richland riverfront road roads roadways rural safety school schools senate services sewage sewer shelter site society solid specifications state station steering stormwater street streets subdivision system tax team tech tif town township trail transit treatment trust union unit united university update updates utilities utility vehicle vehicles village wastewater water week works year youth zoning".split(
		" ",
	),
);

/** First in a street's name ("South Ridge Lane"), never in a person's. */
const DIRECTIONS: ReadonlySet<string> = new Set([
	"north",
	"south",
	"east",
	"west",
]);

function wordOf(word: string): string {
	return word.replace(/\.$/, "").toLowerCase();
}

/**
 * The name in a capitalised run, as the run writes it, or null if it has none.
 * `after` is the text following the run.
 */
function nameIn(run: string, after: string): string | null {
	const words = run.replace(/['’]s$/, "").split(" ");
	const lastTitle = words
		.map((word) =>
			wordOf(word)
				.split("-")
				.some((part) => TITLES.has(part)),
		)
		.lastIndexOf(true);
	let rest = words.slice(lastTitle + 1);
	if (lastTitle === -1) {
		while (rest[0] !== undefined && OPENERS.has(wordOf(rest[0]))) {
			rest = rest.slice(1);
		}
		while (rest.length > 2 && DATE_WORDS.has(wordOf(rest[0] ?? ""))) {
			rest = rest.slice(1);
		}
	}
	if (DIRECTIONS.has(wordOf(rest[0] ?? "")) && rest.length > 1) return null;
	if (rest.some((word) => NOT_A_PERSON.has(wordOf(word)))) return null;
	const full = rest.filter((word) => !/^\p{Lu}\.$/u.test(word)).length >= 2;
	const lastNameAlone =
		rest.length === 1 && (lastTitle !== -1 || ATTRIBUTION.test(after));
	return full || lastNameAlone ? rest.join(" ") : null;
}

/**
 * The people `text` names, each once, as it writes them and without their
 * titles: a first and last name, or a last name after a title ("Mr. Oldham")
 * or before an attribution verb ("Oldham said"). Words in capitals are not
 * read, so "KEVIN PALMER" is not.
 */
export function extractNames(text: string): readonly string[] {
	const names = [...text.matchAll(CAPITALISED_RUN)].flatMap((match) => {
		const end = match.index + match[0].length;
		const name = nameIn(match[0], text.slice(end, end + 20));
		return name === null ? [] : [name];
	});
	return [...new Set(names)];
}

/** Lowercased words, with punctuation and single letters gone. */
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.replaceAll("’", "'")
		.replace(/'s\b/g, "")
		.split(/[^\p{L}\d'-]+/u)
		.filter((word) => word.length > 1);
}

/** Whether `name`'s words stand next to each other in `text`, in order. */
function namedIn(name: string, text: string): boolean {
	const phrase = wordsOf(name).join(" ");
	return ` ${wordsOf(text).join(" ")} `.includes(` ${phrase} `);
}

/**
 * Whether the list grounds `name`: a form of an official's name, or for a last
 * name alone, the last word of one.
 */
function onOfficialsList(
	name: string,
	officials: readonly Official[],
): boolean {
	const wanted = wordsOf(name).join(" ");
	const forms = officials.flatMap((official) =>
		[official.name, ...official.variants].map(wordsOf),
	);
	return forms.some(
		(form) =>
			form.join(" ") === wanted ||
			(!wanted.includes(" ") && form.at(-1) === wanted),
	);
}

function isGrounded(name: string, ctx: CheckContext): boolean {
	return (
		onOfficialsList(name, ctx.officials) ||
		ctx.input.sources.some((source) => namedIn(name, source.text))
	);
}

/**
 * A1 for names. Everyone the headline, highlights and prose name must be
 * written in the meeting's documents or transcript, or be on the body's
 * officials list for the meeting's date.
 */
export const namesCheck: CodeCheck = {
	owns: ["A1"],
	run: (draft, ctx) => {
		const failures = passagesOf(draft).flatMap((passage) =>
			extractNames(passage)
				.filter((name) => !isGrounded(name, ctx))
				.map((name) => {
					const sentence =
						sentencesOf(passage).find((s) => s.includes(name)) ?? passage;
					return `"${name}" is in no source: "${sentence}"`;
				}),
		);
		return { A1: failOrPass(failures) };
	},
};
