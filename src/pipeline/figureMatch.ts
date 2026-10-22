/** Words that multiply the number before them, in cents per unit. */
const SCALE_CENTS: Readonly<Record<string, bigint>> = {
	thousand: 100_000n,
	million: 100_000_000n,
	billion: 100_000_000_000n,
};

/**
 * A written dollar figure: whole dollars in groups of three digits, then
 * cents. The separator before the cents may be a period, a comma, or missing
 * after a comma group, as a caption writes "$244,21510". A number followed by
 * more digits ends where the cents or the group would stop. A dollar sign
 * directly before the number, with at most one space between, is noted. A
 * scale word after the number multiplies it ("$1.2 million"), and a single
 * decimal digit is read only before a scale word or a percent. Before a scale
 * word, exactly three digits after a period are decimals too ("$1.375
 * million"), since a million written with a period for a comma is not
 * written.
 */
const FIGURE_PATTERN =
	/(?<dollarSign>\$ ?)?(?<dollars>\d+(?:[.,]\d{3})*)(?:[.,](?<cents>\d{2})|(?<=,\d{3})(?<runOn>\d{2})|\.(?<tenths>\d)(?=\s?(?:million|thousand|billion|percent|%)))?(?!\d)(?:\s?(?<scale>million|thousand|billion)\b)?/g;

/** A number as a text writes it. */
export type WrittenFigure = {
	/** Whole dollars, without separators. */
	dollars: string;
	/** Two digits; "00" when none are written. */
	cents: string;
	/** The whole value in cents. */
	value: bigint;
	/**
	 * The smallest step the written form can tell apart, in cents: 1 when cents
	 * are written, 100 for whole dollars, 10,000,000 for "$1.2 million".
	 */
	precision: bigint;
	hasDollarSign: boolean;
	hasScale: boolean;
	/** The figure as written, and where it starts. */
	text: string;
	index: number;
};

/**
 * A written number as dollars and cents. Separators in the dollars are
 * dropped, so a period read for a comma ("$258.400.00") is the same figure; a
 * missing cents part is ".00". The cents are kept apart from the dollars so a
 * stray or missing separator cannot change the magnitude.
 */
export function figuresIn(text: string): WrittenFigure[] {
	return [...text.matchAll(FIGURE_PATTERN)].map((match) => {
		const groups = match.groups ?? {};
		const scale = groups.scale === undefined ? 1n : SCALE_CENTS[groups.scale];
		const writtenCents = groups.cents ?? groups.runOn;
		const fraction =
			writtenCents ??
			(groups.tenths === undefined ? "00" : `${groups.tenths}0`);
		const thousandths =
			groups.scale !== undefined && /^\d+\.\d{3}$/.test(groups.dollars ?? "");
		const units =
			BigInt((groups.dollars ?? "").replace(/\D/g, "") || "0") * 100n +
			BigInt(fraction);
		const value = thousandths
			? (units * scale) / 1000n / 100n
			: groups.scale === undefined
				? units
				: (units * scale) / 100n;
		const step =
			writtenCents !== undefined
				? 1n
				: groups.tenths !== undefined
					? 10n
					: 100n;
		return {
			dollars: (value / 100n).toString(),
			cents: (value % 100n).toString().padStart(2, "0"),
			value,
			precision: thousandths
				? scale / 1000n
				: groups.scale === undefined
					? step
					: (step * scale) / 100n,
			hasDollarSign: groups.dollarSign !== undefined,
			hasScale: groups.scale !== undefined,
			text: match[0],
			index: match.index,
		};
	});
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
			found.value === wanted.value &&
			(found.hasDollarSign || !options.asDollarAmount),
	);
}
