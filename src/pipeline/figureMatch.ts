/**
 * A written dollar figure: whole dollars in groups of three digits, then
 * cents. The separator before the cents may be a period, a comma, or missing
 * after a comma group, as a caption writes "$244,21510". A number followed by
 * more digits ends where the cents or the group would stop. A dollar sign
 * directly before the number, with at most one space between, is noted.
 */
const FIGURE_PATTERN =
	/(?<dollarSign>\$ ?)?(?<dollars>\d+(?:[.,]\d{3})*)(?:[.,](?<cents>\d{2})|(?<=,\d{3})(?<runOn>\d{2}))?(?!\d)/g;

/**
 * A written number as dollars and cents. Separators in the dollars are
 * dropped, so a period read for a comma ("$258.400.00") is the same figure; a
 * missing cents part is ".00". The cents are kept apart from the dollars so a
 * stray or missing separator cannot change the magnitude.
 */
export function figuresIn(
	text: string,
): { dollars: string; cents: string; hasDollarSign: boolean }[] {
	return [...text.matchAll(FIGURE_PATTERN)].map((match) => ({
		dollars: (match.groups?.dollars ?? "").replace(/\D/g, ""),
		cents: match.groups?.cents ?? match.groups?.runOn ?? "00",
		hasDollarSign: match.groups?.dollarSign !== undefined,
	}));
}

/** How strictly a figure must be written to count as found. */
export type FigureSearch = {
	/**
	 * Count only an occurrence written with a dollar sign. Documents write
	 * their figures that way, so a bare number with the same digits is some
	 * other number. Captions often drop the sign, so a transcript is
	 * searched without this.
	 */
	asDollarAmount?: boolean;
};

/** Whether `originalAmount` names a dollar figure, as opposed to "not stated". */
export function statesFigure(originalAmount: string): boolean {
	return /\d/.test(originalAmount);
}

/**
 * Whether the first number in `originalAmount` appears in `text` with the same
 * dollars and the same cents. A period read for a comma ("$258.400.00"), a
 * dropped comma and a missing ".00" do not hide a figure that is there; a
 * figure with cents is not found by its dollars alone, and "$750.00" is not
 * found in "$75,000". A figure broken by a space inside its digits is not
 * found. An amount that names no figure is found by its exact wording.
 */
export function figureIsIn(
	originalAmount: string,
	text: string,
	options: FigureSearch = {},
): boolean {
	const wanted = figuresIn(originalAmount)[0];
	if (wanted === undefined) return text.includes(originalAmount);
	return figuresIn(text).some(
		(found) =>
			found.dollars === wanted.dollars &&
			found.cents === wanted.cents &&
			(found.hasDollarSign || !options.asDollarAmount),
	);
}
