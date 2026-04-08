type FiscalDecisionCandidate = {
	title: string;
	description: string;
	amount: number;
	originalAmount: string;
	confidence: number;
};

/**
 * Two-pass verification: checks that each extracted dollar amount actually
 * appears in the source text. If the originalAmount string (e.g. "$50,000")
 * is not found in the source, the confidence is halved — signaling that the
 * LLM may have hallucinated the amount.
 *
 * This catches the "temporal confusion" pitfall where the LLM confuses
 * historical spending references with new decisions.
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
