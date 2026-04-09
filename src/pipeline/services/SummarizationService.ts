/**
 * The minimum shape a fiscal decision must have for amount verification.
 * This is the input contract for {@link verifyAmounts}.
 *
 * The generic constraint `<T extends FiscalDecisionCandidate>` in verifyAmounts
 * means callers can pass objects with additional fields (like `vendor`,
 * `budgetCategory`) and those fields will be preserved in the output — the
 * function only reads the fields it needs.
 */
type FiscalDecisionCandidate = {
	title: string;
	description: string;
	amount: number;
	/** The raw dollar string as extracted by the LLM (e.g. "$50,000"). */
	originalAmount: string;
	/** 0.0–1.0 confidence score, downgraded by verification if the amount can't be found. */
	confidence: number;
};

/**
 * Two-pass verification: checks that each extracted dollar amount actually
 * appears in the source text. If the `originalAmount` string (e.g. `"$50,000"`)
 * is not found in the source, the confidence is reduced by 60% — signaling
 * that the LLM may have hallucinated the amount.
 *
 * This catches the "temporal confusion" pitfall where the LLM confuses
 * historical spending references with new decisions. For example, if the
 * minutes say "last year the council spent $200,000 on roads" and the LLM
 * extracts that as a new fiscal decision, the verification step will flag it
 * because `"$200,000"` may appear but in a historical context. (Future
 * iterations may use sentence-level matching rather than document-level.)
 *
 * The function is generic — it accepts and returns objects with any additional
 * fields beyond FiscalDecisionCandidate, only modifying `confidence`.
 *
 * @param decisions - LLM-extracted fiscal decisions to verify.
 * @param sourceText - The raw meeting minutes or transcript text.
 * @returns The same array with confidence scores adjusted for unverified amounts.
 */
function verifyAmounts<T extends FiscalDecisionCandidate>(
	decisions: T[],
	sourceText: string,
): T[] {
	return decisions.map((decision) => {
		const found = sourceText.includes(decision.originalAmount);
		if (found) return decision;
		return { ...decision, confidence: decision.confidence * 0.4 };
	});
}

export { verifyAmounts };
export type { FiscalDecisionCandidate };
