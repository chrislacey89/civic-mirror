import { describe, expect, it } from "vitest";
import { verifyAmounts } from "./SummarizationService.ts";

const SOURCE_TEXT = `
The Town Council approved a motion to allocate $50,000 for road repairs
on Sale Street. Council member Smith moved to approve the $12,500 contract
with ABC Paving for sidewalk improvements. The motion passed 4-1.
`;

describe("SummarizationService", () => {
	describe("verifyAmounts", () => {
		it("keeps full confidence when amounts appear in source text", () => {
			const decisions = [
				{
					title: "Road Repairs",
					description: "Sale Street road repairs",
					amount: 50000,
					originalAmount: "$50,000",
					confidence: 0.95,
				},
				{
					title: "Sidewalk Contract",
					description: "ABC Paving sidewalk improvements",
					amount: 12500,
					originalAmount: "$12,500",
					confidence: 0.9,
				},
			];

			const verified = verifyAmounts(decisions, SOURCE_TEXT);

			expect(verified[0].confidence).toBe(0.95);
			expect(verified[1].confidence).toBe(0.9);
		});

		it("downgrades confidence when amounts are not found in source text", () => {
			const decisions = [
				{
					title: "Road Repairs",
					description: "Sale Street road repairs",
					amount: 50000,
					originalAmount: "$50,000",
					confidence: 0.95,
				},
				{
					title: "Phantom Budget Item",
					description: "This was hallucinated by the LLM",
					amount: 75000,
					originalAmount: "$75,000",
					confidence: 0.85,
				},
			];

			const verified = verifyAmounts(decisions, SOURCE_TEXT);

			// Real amount keeps confidence
			expect(verified[0].confidence).toBe(0.95);
			// Hallucinated amount gets downgraded
			expect(verified[1].confidence).toBeLessThan(0.5);
		});
	});
});
