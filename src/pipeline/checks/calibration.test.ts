import { describe, expect, it } from "vitest";
import {
	applyEdit,
	applySourceEdits,
	type CalibrationScore,
	clearsBars,
	codeSeesEdit,
	scoreCheck,
} from "./calibration.ts";
import type { CheckReport } from "./types.ts";

const draft = {
	highlights: ["Council approves paving bid", "Vote was 4-1"],
	prose: "Smith moved to approve. The council approved the bid.",
};

describe("applyEdit", () => {
	it("replaces the one occurrence of `before` in a prose sentence", () => {
		expect(
			applyEdit(draft, {
				id: "A2-F-01",
				target: { field: "prose", sentence: "Smith moved to approve." },
				before: "Smith moved to approve.",
				after: "Smith sensibly moved to approve.",
			}),
		).toEqual({
			...draft,
			prose: "Smith sensibly moved to approve. The council approved the bid.",
		});
	});

	it("replaces `before` within the indexed highlight", () => {
		expect(
			applyEdit(draft, {
				id: "A4-F-01",
				target: { field: "highlights", index: 0 },
				before: "approves",
				after: "tables",
			})?.highlights,
		).toEqual(["Council tables paving bid", "Vote was 4-1"]);
	});

	it("is null when `before` is not in the draft once, so the edit no longer applies", () => {
		expect(
			applyEdit(draft, {
				id: "A4-F-02",
				target: { field: "prose", sentence: "approve" },
				before: "approve",
				after: "deny",
			}),
		).toBeNull();
	});
});

describe("applySourceEdits", () => {
	const sources = [
		{
			kind: "documents" as const,
			text: "Privilege of the Floor\nJim Perry from the public spoke.",
		},
		{ kind: "transcript" as const, text: "Jim Perry from the public spoke." },
	];

	it("replaces each `before` once in the documents and leaves the transcript alone", () => {
		expect(
			applySourceEdits(sources, [
				{ before: "Privilege of the Floor\n", after: "" },
				{ before: "Jim Perry", after: "Earl Whitcomb" },
			]),
		).toEqual([
			{ kind: "documents", text: "Earl Whitcomb from the public spoke." },
			sources[1],
		]);
	});

	it("is null when a `before` is not in the documents exactly once", () => {
		expect(
			applySourceEdits(sources, [
				{ before: "Tom Orman", after: "Lyle Haverkamp" },
			]),
		).toBeNull();
		expect(
			applySourceEdits(
				[sources[0], sources[0]],
				[{ before: "Jim Perry", after: "Earl Whitcomb" }],
			),
		).toBeNull();
	});
});

describe("codeSeesEdit", () => {
	const pass = { outcome: "pass" } as const;
	const fail = { outcome: "fail", evidence: "x" } as const;
	const unchecked = { outcome: "unchecked", reason: "a name" } as const;
	const report = (verdicts: CheckReport["verdicts"]) => ({ verdicts });

	it.each([
		["no gate changes", { A1: pass }, { A1: pass }, false],
		["a gate goes from pass to fail", { A1: pass }, { A1: fail }, true],
		[
			"a gate the judge decides when unchecked goes to unchecked",
			{ A5: pass },
			{ A5: unchecked },
			false,
		],
		[
			"a gate the judge decides when unchecked goes to fail",
			{ A5: pass },
			{ A5: fail },
			true,
		],
		["another gate goes to unchecked", { A1: pass }, { A1: unchecked }, true],
	] as const)("when %s, code sees the edit: %4$s", (_, base, edited, seen) => {
		expect(codeSeesEdit(report(base), report(edited), ["A5"])).toBe(seen);
	});
});

/** `n` items with this label and these two judge verdicts. */
function items(
	n: number,
	label: "pass" | "fail",
	run1: "pass" | "fail",
	run2: "pass" | "fail" = run1,
) {
	return Array.from({ length: n }, () => ({
		label,
		runs: [run1, run2] as const,
	}));
}

describe("scoreCheck", () => {
	it("gives catch rate over fails, false-refusal rate over passes, per run, and how often the runs agree", () => {
		const score = scoreCheck([
			...items(9, "fail", "fail"),
			...items(1, "fail", "pass", "fail"),
			...items(18, "pass", "pass"),
			...items(2, "pass", "fail", "pass"),
		]);
		expect(score).toEqual({
			n: 30,
			fails: 10,
			catchRate: [0.9, 1],
			falseRefusal: [0.1, 0],
			selfAgreement: 0.9,
		});
	});

	it("has no catch rate when no item is labelled fail", () => {
		expect(scoreCheck(items(3, "pass", "pass")).catchRate).toEqual([
			null,
			null,
		]);
	});
});

describe("clearsBars", () => {
	const clearing: CalibrationScore = {
		n: 78,
		fails: 10,
		catchRate: [0.9, 1],
		falseRefusal: [0.1, 0.05],
		selfAgreement: 0.9,
	};

	it("clears at 10 fails measured, catch ≥ 0.9, false refusal ≤ 0.1 and self-agreement ≥ 0.9 in both runs", () => {
		expect(clearsBars(clearing)).toBe(true);
	});

	it.each([
		["fewer than 10 fails were measured", { fails: 9 }],
		["a run's catch rate is below 0.9", { catchRate: [0.89, 1] }],
		["a run's false refusal is above 0.1", { falseRefusal: [0.05, 0.11] }],
		["self-agreement is below 0.9", { selfAgreement: 0.89 }],
		["no fail was measured", { catchRate: [null, null] }],
	] as const)("misses when %s", (_, change) => {
		expect(clearsBars({ ...clearing, ...change })).toBe(false);
	});
});
