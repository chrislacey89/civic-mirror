import { describe, expect, it } from "vitest";
import { prePublish, toPublication } from "./prePublish.ts";
import type {
	CheckContext,
	CodeCheck,
	PrePublishOutcome,
	WrittenDraft,
} from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
};

function drafted(prose: string): WrittenDraft {
	return {
		highlights: ["Council approves $139,775 paving bid"],
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

describe("prePublish", () => {
	it("publishes a draft that passes every check", () => {
		const outcome = prePublish({ draft: complete, context });
		expect(outcome.kind).toBe("publish");
		expect(outcome.best).toBe(complete);
	});

	it("publishes flagged a draft whose gates pass and a style check fails", () => {
		const outcome = prePublish({
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
		const outcome = prePublish({ draft: truncated, context });
		expect(outcome).toMatchObject({
			kind: "held",
			reason: "gate-failed",
			best: truncated,
			gateFails: ["TRUNC"],
		});
	});

	it("holds a draft whose gate is unchecked", () => {
		const outcome = prePublish({
			draft: complete,
			context,
			checks: [undecidedA1],
		});
		expect(outcome).toMatchObject({ kind: "held", gateFails: ["A1"] });
	});

	it("records the one round it ran, with the judge skipped", () => {
		const outcome = prePublish({ draft: truncated, context });
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
	const rounds = prePublish({ draft: complete, context }).rounds;

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
