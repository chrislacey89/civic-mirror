import { describe, expect, it } from "vitest";
import {
	checkDraft,
	gateEvidence,
	prePublish,
	toPublication,
} from "./prePublish.ts";
import {
	type CheckContext,
	type CodeCheck,
	type Feedback,
	GATE_IDS,
	type PrePublishOutcome,
	type WrittenDraft,
} from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
};

function drafted(prose: string): WrittenDraft {
	return {
		highlights: ["Council approves paving bid"],
		prose,
		finishReason: "stop",
		usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 40 },
	};
}

const complete = drafted("The council approved the paving bid.");
const truncated = drafted("The council approved the paving bid for");

/** A style check that fails B3 on every draft. */
const longHeadline: CodeCheck = {
	owns: ["B3"],
	run: () => ({ B3: { outcome: "fail", evidence: '"a long headline"' } }),
};

/** A gate check that cannot decide A1. */
const undecidedA1: CodeCheck = {
	owns: ["A1"],
	run: () => ({ A1: { outcome: "unchecked", reason: "no names list" } }),
};

describe("checkDraft", () => {
	it("records how many figures the draft states that a source writes", () => {
		const outcome = checkDraft({
			draft: drafted("The council approved the $139,775.03 paving bid."),
			context: {
				...context,
				input: {
					...context.input,
					sources: [{ kind: "documents", text: "Paving bid $139,775.03." }],
				},
			},
		});
		expect(outcome.rounds[0]?.groundedFigures).toBe(1);
	});

	it("publishes a draft that passes every check", () => {
		const outcome = checkDraft({ draft: complete, context });
		expect(outcome.kind).toBe("publish");
		expect(outcome.best).toBe(complete);
	});

	it("publishes flagged a draft whose gates pass and a style check fails", () => {
		const outcome = checkDraft({
			draft: complete,
			context,
			checks: [longHeadline],
		});
		expect(outcome).toMatchObject({
			kind: "publish-flagged",
			best: complete,
			styleFails: ["B3"],
		});
	});

	it("holds a draft that fails a gate, with reason gate-failed", () => {
		const outcome = checkDraft({ draft: truncated, context });
		expect(outcome).toMatchObject({
			kind: "held",
			reason: "gate-failed",
			best: truncated,
			gateFails: ["TRUNC"],
		});
	});

	it("holds a draft whose gate is unchecked", () => {
		const outcome = checkDraft({
			draft: complete,
			context,
			checks: [undecidedA1],
		});
		expect(outcome).toMatchObject({ kind: "held", gateFails: ["A1"] });
	});

	it("records the one round it ran, with the judge skipped", () => {
		const outcome = checkDraft({ draft: truncated, context });
		expect(outcome.rounds).toHaveLength(1);
		expect(outcome.rounds[0]).toMatchObject({
			round: 1,
			draft: truncated,
			judge: "skipped",
			gateFailures: 1,
			code: { verdicts: { TRUNC: { outcome: "fail" } } },
		});
	});
});

describe("toPublication", () => {
	const rounds = checkDraft({ draft: complete, context }).rounds;

	it.each([
		[
			{ kind: "publish", best: complete, rounds },
			{ status: "published", heldReason: null },
		],
		[
			{ kind: "publish-flagged", best: complete, styleFails: ["B3"], rounds },
			{ status: "published", heldReason: null },
		],
		[
			{
				kind: "held",
				reason: "gate-failed",
				best: complete,
				gateFails: ["TRUNC"],
				rounds,
			},
			{ status: "held", heldReason: "gate-failed" },
		],
		[
			{
				kind: "held",
				reason: "critic-unavailable",
				best: complete,
				gateFails: [],
				rounds,
			},
			{ status: "held", heldReason: "critic-unavailable" },
		],
	] satisfies [
		PrePublishOutcome,
		object,
	][])("stores a %o outcome as %o", (outcome, expected) => {
		expect(toPublication(outcome, "run-1")).toEqual({
			...expected,
			runId: "run-1",
			rounds,
		});
	});
});

describe("gateEvidence", () => {
	it("quotes each failed gate of the best round, by id", () => {
		const outcome = checkDraft({ draft: truncated, context });
		expect(gateEvidence(outcome)).toEqual([
			"TRUNC: The council approved the paving bid for",
		]);
	});

	it("gives the reason for an unchecked gate", () => {
		const outcome = checkDraft({
			draft: complete,
			context,
			checks: [undecidedA1],
		});
		expect(gateEvidence(outcome)).toEqual(["A1: unchecked (no names list)"]);
	});

	it("is empty for a published outcome", () => {
		expect(gateEvidence(checkDraft({ draft: complete, context }))).toEqual([]);
	});
});

describe("prePublish", () => {
	/** A writer that returns `drafts` in order, counting its calls. */
	function writer(...drafts: WrittenDraft[]) {
		const calls: (readonly Feedback[])[] = [];
		return {
			calls,
			revise: async (feedback: readonly Feedback[]) => {
				calls.push(feedback);
				const next = drafts[calls.length - 1];
				if (next === undefined) throw new Error("no more drafts");
				return next;
			},
		};
	}

	it("when round 1 fails a gate and round 2 passes every gate, publishes round 2's draft and stores both rounds under one runId", async () => {
		const { revise, calls } = writer(complete);
		const outcome = await prePublish({
			draft: truncated,
			context,
			revise,
			cap: 7,
		});
		expect(outcome).toMatchObject({ kind: "publish", best: complete });
		expect(outcome.rounds.map((r) => r.draft)).toEqual([truncated, complete]);
		expect(outcome.rounds.map((r) => r.round)).toEqual([1, 2]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.map((item) => item.checkId)).toEqual(["TRUNC"]);
		const publication = toPublication(outcome, "run-1");
		expect(publication).toMatchObject({ runId: "run-1", status: "published" });
		expect(publication.rounds).toHaveLength(2);
	});

	/** A draft that fails its first `n` gates under {@link scripted}. */
	function failing(n: number, prose = "The council met."): WrittenDraft {
		return { ...drafted(prose), highlights: [`fails ${n}`] };
	}

	/** Fails as many gates as the draft's highlight says. */
	const scripted: CodeCheck = {
		owns: GATE_IDS,
		run: (draft) => {
			const n = Number(draft.highlights[0]?.replace("fails ", "") ?? 0);
			return Object.fromEntries(
				GATE_IDS.map((id, index) => [
					id,
					index < n
						? { outcome: "fail", evidence: `"${draft.prose}"` }
						: { outcome: "pass" },
				]),
			);
		},
	};

	it("if a round fails more gates than the best, stops and returns the best draft, not the last", async () => {
		const second = failing(1);
		const third = failing(2);
		const { revise, calls } = writer(second, third, failing(0));
		const outcome = await prePublish({
			draft: failing(3),
			context,
			revise,
			cap: 7,
			checks: [scripted],
		});
		expect(calls).toHaveLength(2);
		expect(outcome.rounds).toHaveLength(3);
		expect(outcome).toMatchObject({ kind: "held", best: second });
		expect(outcome.kind === "held" && outcome.gateFails).toEqual(["A1"]);
	});

	it("if a round fails as many gates as the best, keeps revising from it", async () => {
		const second = failing(1, "The council met on Monday.");
		const { revise, calls } = writer(second, failing(0));
		const outcome = await prePublish({
			draft: failing(1),
			context,
			revise,
			cap: 7,
			checks: [scripted],
		});
		expect(calls).toHaveLength(2);
		expect(outcome.rounds).toHaveLength(3);
		expect(calls[1]?.[0]?.quote).toContain("Monday");
		expect(outcome).toMatchObject({ kind: "publish", best: failing(0) });
	});

	it("if a revision fixes some of a gate's failed items, keeps revising from it", async () => {
		/** Fails A1 with one evidence line per sentence of the prose. */
		const perSentence: CodeCheck = {
			owns: ["A1"],
			run: (draft) => {
				const lines = draft.prose
					.split(". ")
					.map((sentence) => `"${sentence}" is in no source: "x"`);
				return { A1: { outcome: "fail", evidence: lines.join("\n") } };
			},
		};
		const fewer = drafted("Bid $9");
		const { revise, calls } = writer(fewer);
		const outcome = await prePublish({
			draft: drafted("Bid $5. Bid $6. Bid $7"),
			context,
			revise,
			cap: 7,
			checks: [perSentence],
		});
		expect(calls.map((feedback) => feedback.length)).toEqual([3, 1]);
		expect(outcome.rounds).toHaveLength(2);
		expect(outcome).toMatchObject({ kind: "held", best: fewer });
	});

	it("if a round passes more gates but keeps fewer grounded figures than the best, stops and keeps the best", async () => {
		const sourced: CheckContext = {
			...context,
			input: {
				...context.input,
				sources: [{ kind: "documents", text: "Paving bid $139,775.03." }],
			},
		};
		const withFigure = failing(1, "The council accepted the $139,775.03 bid.");
		const { revise, calls } = writer(
			failing(0, "The council accepted a bid."),
			failing(0, "The council accepted the $139,775.03 bid."),
		);
		const outcome = await prePublish({
			draft: withFigure,
			context: sourced,
			revise,
			cap: 7,
			checks: [scripted],
		});
		expect(calls).toHaveLength(1);
		expect(outcome.rounds.map((r) => r.groundedFigures)).toEqual([1, 0]);
		expect(outcome).toMatchObject({ kind: "held", best: withFigure });
	});

	it("at the cap, makes at most `cap` writing calls", async () => {
		const { revise, calls } = writer(
			failing(5),
			failing(4),
			failing(3),
			failing(2),
		);
		const outcome = await prePublish({
			draft: failing(6),
			context,
			revise,
			cap: 3,
			checks: [scripted],
		});
		// The first draft is one of the cap's writing calls.
		expect(1 + calls.length).toBe(3);
		expect(outcome.rounds).toHaveLength(3);
		expect(outcome.best).toEqual(failing(4));
	});

	it("does not revise a draft that passes every check", async () => {
		const { revise, calls } = writer();
		const outcome = await prePublish({
			draft: complete,
			context,
			revise,
			cap: 7,
		});
		expect(calls).toHaveLength(0);
		expect(outcome.kind).toBe("publish");
	});

	it("revises a draft whose only failure is a style check", async () => {
		const { revise, calls } = writer(complete);
		const outcome = await prePublish({
			draft: complete,
			context,
			revise,
			cap: 7,
			checks: [longHeadline],
		});
		expect(calls[0]?.map((item) => item.checkId)).toEqual(["B3"]);
		expect(outcome.kind).toBe("publish-flagged");
	});

	it("if a revision call fails, ends the loop with the best draft so far", async () => {
		const second = failing(1);
		const { revise, calls } = writer(second);
		const outcome = await prePublish({
			draft: failing(2),
			context,
			revise,
			cap: 7,
			checks: [scripted],
		});
		expect(calls).toHaveLength(2);
		expect(outcome.rounds).toHaveLength(2);
		expect(outcome.best).toBe(second);
	});

	it("never publishes when the best draft has a gate failure, over random verdict sequences", async () => {
		let seed = 202;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const gateCount = () => Math.floor(random() * 3) * Math.floor(random() * 3);
		for (let trial = 0; trial < 500; trial++) {
			const drafts = Array.from({ length: 8 }, () => failing(gateCount()));
			const { revise, calls } = writer(...drafts.slice(1));
			const cap = 1 + Math.floor(random() * 7);
			const outcome = await prePublish({
				draft: drafts[0] as WrittenDraft,
				context,
				revise,
				cap,
				checks: [scripted],
			});
			const best = outcome.rounds.find((r) => r.draft === outcome.best);
			expect(best).toBeDefined();
			if (outcome.kind !== "held") expect(best?.gateFailures).toBe(0);
			else expect(best?.gateFailures).toBeGreaterThan(0);
			expect(1 + calls.length).toBeLessThanOrEqual(cap);
			const fewest = Math.min(...outcome.rounds.map((r) => r.gateFailures));
			expect(best?.gateFailures).toBe(fewest);
		}
	});
});
