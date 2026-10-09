import { describe, expect, it } from "vitest";
import { judgeRuns } from "./summarize-repeat-verdict.ts";

const decided = (amount: number) => ({
	summary: {
		fiscalDecisions: [{ status: "approved", amount, ordinanceNumber: "O-1" }],
		highlights: [],
		prose: "",
	},
});

describe("judgeRuns", () => {
	it("exits 0 when every run gives the same decisions", () => {
		expect(judgeRuns([decided(5), decided(5)])).toMatchObject({
			exitCode: 0,
			distinct: 1,
		});
	});

	it("exits 1 when the runs differ", () => {
		expect(judgeRuns([decided(5), decided(6)])).toMatchObject({
			exitCode: 1,
			distinct: 2,
		});
	});

	it("exits 3, not 0 or 1, when a run failed, even if the finished runs agree or differ", () => {
		const agree = judgeRuns([decided(5), { failure: "429" }, decided(5)]);
		expect(agree).toEqual({
			exitCode: 3,
			distinct: null,
			failedRuns: [{ run: 2, failure: "429" }],
		});
		expect(judgeRuns([decided(5), decided(6), { failure: "x" }]).exitCode).toBe(
			3,
		);
	});
});
