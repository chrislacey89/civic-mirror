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
