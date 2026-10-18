import { describe, expect, it } from "vitest";
import { CODE_CHECKS, runCodeChecks } from "./index.ts";
import type { CheckContext, CodeCheck, Verdict } from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
};

const draft = { highlights: ["Council approves budget"], prose: "It did." };

/** A check that owns A1 and returns the given verdict for it. */
function a1(verdict: Verdict | undefined): CodeCheck {
	return { owns: ["A1"], run: () => (verdict ? { A1: verdict } : {}) };
}

describe("runCodeChecks", () => {
	it("registers the truncation check", () => {
		expect(runCodeChecks(draft, context).verdicts.TRUNC).toEqual({
			outcome: "pass",
		});
		expect(CODE_CHECKS.flatMap((check) => check.owns)).toContain("TRUNC");
	});

	it("reports an owned id that got no verdict as unchecked", () => {
		expect(runCodeChecks(draft, context, [a1(undefined)]).verdicts).toEqual({
			A1: { outcome: "unchecked", reason: "no verdict" },
		});
	});

	it("drops a verdict for an id the check does not own", () => {
		const overreaching: CodeCheck = {
			owns: ["A1"],
			run: () => ({ A1: { outcome: "pass" }, A3: { outcome: "pass" } }),
		};
		expect(
			Object.keys(runCodeChecks(draft, context, [overreaching]).verdicts),
		).toEqual(["A1"]);
	});

	describe("when two registered checks own the same id", () => {
		const pass: Verdict = { outcome: "pass" };
		const unchecked: Verdict = {
			outcome: "unchecked",
			reason: "no names list",
		};
		const failFigure: Verdict = { outcome: "fail", evidence: '"$682,824"' };
		const failName: Verdict = { outcome: "fail", evidence: '"Kevin Palmer"' };

		it("fails when either fails, whatever the other says", () => {
			for (const other of [pass, unchecked, failName]) {
				expect(
					runCodeChecks(draft, context, [a1(other), a1(failFigure)]).verdicts.A1
						?.outcome,
				).toBe("fail");
			}
		});

		it("concatenates the evidence of every failure", () => {
			expect(
				runCodeChecks(draft, context, [a1(failFigure), a1(failName)]).verdicts
					.A1,
			).toEqual({
				outcome: "fail",
				evidence: '"$682,824"\n"Kevin Palmer"',
			});
		});

		it("is unchecked when none fails and either is unchecked", () => {
			expect(
				runCodeChecks(draft, context, [a1(pass), a1(unchecked)]).verdicts.A1,
			).toEqual(unchecked);
		});

		it("passes only when both pass", () => {
			expect(
				runCodeChecks(draft, context, [a1(pass), a1(pass)]).verdicts.A1,
			).toEqual(pass);
		});
	});
});
