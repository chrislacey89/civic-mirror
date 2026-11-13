import { describe, expect, it } from "vitest";
import type { Judge } from "./judge.ts";
import { gateEvidence, prePublish } from "./prePublish.ts";
import type {
	CheckContext,
	CheckReport,
	CodeCheck,
	Revision,
	Verdict,
	WrittenDraft,
} from "./types.ts";

const documentsMeeting: CheckContext = {
	input: {
		meetingContext: "Town Council, 2026-05-11",
		sources: [{ kind: "documents", text: "Council approved the paving bid." }],
	},
	ledger: [],
	officials: [],
};

const transcriptMeeting: CheckContext = {
	...documentsMeeting,
	input: {
		...documentsMeeting.input,
		sources: [{ kind: "transcript", text: "we approve the paving bid" }],
	},
};

function drafted(prose: string): WrittenDraft {
	return {
		highlights: ["Council approves paving bid"],
		prose,
		finishReason: "stop",
		usage: null,
	};
}

const draft = drafted("The council approved the paving bid.");

const pass: Verdict = { outcome: "pass" };
const fail = (evidence: string): Verdict => ({ outcome: "fail", evidence });

function report(
	verdicts: Partial<Record<"A2" | "A4" | "A5", Verdict>> = {},
): CheckReport {
	return { verdicts: { A2: pass, A4: pass, A5: pass, ...verdicts } };
}

/** A judge that answers `answer` for every draft, counting its calls. */
function judging(
	answer: (draft: { prose: string }) => CheckReport | "unavailable" | Error,
) {
	const calls: string[] = [];
	const judge: Judge = {
		fingerprint: "fp-1",
		run: async ({ draft }) => {
			calls.push(draft.prose);
			const result = answer(draft);
			if (result instanceof Error) throw result;
			return result;
		},
	};
	return { judge, calls };
}

/** Code checks that pass every gate they own, so the judge runs. */
const passingCode: readonly CodeCheck[] = [
	{ owns: ["A2", "A5"], run: () => ({ A2: pass, A5: pass }) },
];

const noRevision = async (): Promise<WrittenDraft> => {
	throw new Error("no revision");
};

describe("prePublish with a judge", () => {
	it("holds a meeting with documents when the judge fails a gated check (A2)", async () => {
		const { judge } = judging(() => report({ A2: fail("sensibly suggested") }));
		const outcome = await prePublish({
			draft,
			context: documentsMeeting,
			revise: noRevision,
			cap: 1,
			checks: passingCode,
			judge,
		});
		expect(outcome).toMatchObject({
			kind: "held",
			reason: "gate-failed",
			gateFails: ["A2"],
		});
		expect(outcome.rounds[0]?.judgeFingerprint).toBe("fp-1");
	});

	it.each([
		["throws", () => new Error("503 from the model")],
		["says it is unavailable", () => "unavailable" as const],
		[
			"leaves out a check it owns",
			() => ({ verdicts: { A2: pass, A4: pass } }),
		],
	])("if the judge %s, then a meeting with documents is held critic-unavailable", async (_, answer) => {
		const { judge } = judging(answer);
		const outcome = await prePublish({
			draft,
			context: documentsMeeting,
			revise: noRevision,
			cap: 3,
			checks: passingCode,
			judge,
		});
		expect(outcome).toMatchObject({
			kind: "held",
			reason: "critic-unavailable",
		});
		expect(outcome.rounds).toHaveLength(1);
		expect(outcome.rounds[0]).toMatchObject({
			judge: "unavailable",
			judgeFingerprint: "fp-1",
		});
	});

	it("while the judge is unavailable, a transcript-only meeting, where it gates nothing, rests on code checks", async () => {
		const { judge } = judging(() => new Error("timeout"));
		const outcome = await prePublish({
			draft,
			context: transcriptMeeting,
			revise: noRevision,
			cap: 1,
			checks: passingCode,
			judge,
		});
		expect(outcome.kind).toBe("publish");
		expect(outcome.rounds[0]?.judge).toBe("unavailable");
	});

	it("flags, and does not hold, a judge fail on a check it may not gate (A4)", async () => {
		const { judge } = judging(() =>
			report({ A4: fail("tabled the ordinance") }),
		);
		const outcome = await prePublish({
			draft,
			context: documentsMeeting,
			revise: noRevision,
			cap: 1,
			checks: passingCode,
			judge,
		});
		expect(outcome).toMatchObject({
			kind: "publish-flagged",
			styleFails: ["A4"],
		});
	});

	it("flags, and does not hold, a judge A2 fail on a transcript-only meeting", async () => {
		const { judge } = judging(() => report({ A2: fail("reluctantly") }));
		const outcome = await prePublish({
			draft,
			context: transcriptMeeting,
			revise: noRevision,
			cap: 1,
			checks: passingCode,
			judge,
		});
		expect(outcome).toMatchObject({
			kind: "publish-flagged",
			styleFails: ["A2"],
		});
	});

	it("does not ask the judge about a draft that fails a code gate", async () => {
		const { judge, calls } = judging(() => report());
		const outcome = await prePublish({
			draft,
			context: documentsMeeting,
			revise: noRevision,
			cap: 1,
			checks: [
				{ owns: ["A2"], run: () => ({ A2: fail('loaded word "sadly"') }) },
			],
			judge,
		});
		expect(calls).toEqual([]);
		expect(outcome).toMatchObject({ kind: "held", reason: "gate-failed" });
		expect(outcome.rounds[0]).toMatchObject({
			judge: "skipped",
			judgeFingerprint: null,
		});
	});

	describe("A5", () => {
		/** Code that cannot tie a name in the draft to any role. */
		const unresolvedName: readonly CodeCheck[] = [
			{
				owns: ["A5"],
				run: () => ({
					A5: {
						outcome: "unchecked",
						reason:
							"a name is on no officials list and has no role in the documents",
					},
				}),
			},
		];

		it("on a meeting with documents, a name code cannot resolve goes to the judge, and its pass publishes", async () => {
			const { judge, calls } = judging(() => report());
			const outcome = await prePublish({
				draft,
				context: documentsMeeting,
				revise: noRevision,
				cap: 1,
				checks: unresolvedName,
				judge,
			});
			expect(calls).toHaveLength(1);
			expect(outcome.kind).toBe("publish");
		});

		it("on a meeting with documents, the judge's fail on an unresolved name holds, and the evidence names no one", async () => {
			const { judge } = judging(() =>
				report({ A5: fail("resident Jane Doe asked about the bid") }),
			);
			const outcome = await prePublish({
				draft,
				context: documentsMeeting,
				revise: noRevision,
				cap: 1,
				checks: unresolvedName,
				judge,
			});
			expect(outcome).toMatchObject({
				kind: "held",
				reason: "gate-failed",
				gateFails: ["A5"],
			});
			const evidence = gateEvidence(outcome).join("\n");
			expect(evidence).toContain("A5 (judge)");
			expect(evidence).not.toContain("Jane Doe");
		});

		it("when code resolved every name, the judge's A5 fail flags and does not hold", async () => {
			const { judge } = judging(() =>
				report({ A5: fail("Town Manager Mike Farmer said") }),
			);
			const outcome = await prePublish({
				draft,
				context: documentsMeeting,
				revise: noRevision,
				cap: 1,
				checks: passingCode,
				judge,
			});
			expect(outcome).toMatchObject({
				kind: "publish-flagged",
				styleFails: ["A5"],
			});
		});

		it("on a transcript-only meeting, an unresolved name holds without asking the judge", async () => {
			const { judge, calls } = judging(() => report());
			const outcome = await prePublish({
				draft,
				context: transcriptMeeting,
				revise: noRevision,
				cap: 1,
				checks: unresolvedName,
				judge,
			});
			expect(calls).toEqual([]);
			expect(outcome).toMatchObject({
				kind: "held",
				reason: "gate-failed",
				gateFails: ["A5"],
			});
		});
	});

	describe("revising", () => {
		const loaded = drafted("The council sensibly approved the paving bid.");
		const plain = drafted("The council approved the paving bid.");

		it("sends a gated judge fail to the writer, and publishes the revision the judge passes", async () => {
			const { judge } = judging(({ prose }) =>
				prose === loaded.prose
					? report({ A2: fail("sensibly approved") })
					: report(),
			);
			const revisions: Revision[] = [];
			const outcome = await prePublish({
				draft: loaded,
				context: documentsMeeting,
				revise: async (revision) => {
					revisions.push(revision);
					return plain;
				},
				cap: 3,
				checks: passingCode,
				judge,
			});
			expect(revisions[0]?.feedback).toEqual([
				{
					checkId: "A2",
					quote: "sensibly approved",
					finding: "No opinion, no motive, no loaded words",
				},
			]);
			expect(outcome).toMatchObject({ kind: "publish", best: plain });
		});

		it("does not count the judge's fails in whether a round is worse: a round the judge alone fails more still replaces the best", async () => {
			const first = drafted("First draft.");
			const second = drafted("Second draft.");
			const { judge } = judging(({ prose }) =>
				prose === first.prose ? report() : report({ A2: fail("Second") }),
			);
			// The first draft fails a style check, so the loop revises it.
			const styleOnFirst: CodeCheck = {
				owns: ["A2", "A5", "B3"],
				run: (d) => ({
					A2: pass,
					A5: pass,
					B3: d.prose === first.prose ? fail('"First draft."') : pass,
				}),
			};
			const outcome = await prePublish({
				draft: first,
				context: documentsMeeting,
				revise: async () => second,
				cap: 2,
				checks: [styleOnFirst],
				judge,
			});
			expect(outcome.rounds.map((r) => r.gateFailures)).toEqual([0, 1]);
			expect(outcome).toMatchObject({ kind: "held", best: second });
		});
	});
});
