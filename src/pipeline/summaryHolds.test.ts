import { describe, expect, it } from "vitest";
import { holdStats, parseReleaseFile } from "#/pipeline/summaryHolds.ts";

describe("parseReleaseFile", () => {
	it("reads the highlights list, then the prose after a blank line", () => {
		expect(
			parseReleaseFile("- One\n- Two\n\nFirst paragraph.\n\nSecond.\n"),
		).toEqual({
			highlights: ["One", "Two"],
			prose: "First paragraph.\n\nSecond.",
		});
	});

	it("is null without highlights, without prose, or without the blank line", () => {
		expect(parseReleaseFile("Just prose.")).toBeNull();
		expect(parseReleaseFile("- One\n\n")).toBeNull();
		expect(parseReleaseFile("- One\nProse right after.")).toBeNull();
	});
});

describe("holdStats", () => {
	const now = new Date("2026-11-13T00:00:00Z");
	const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

	it("counts a meeting held when every round of its latest run in the window fails a gate", () => {
		expect(
			holdStats(
				[
					{ meetingId: 1, runId: "a", gateFailures: 1, createdAt: daysAgo(3) },
					{ meetingId: 1, runId: "a", gateFailures: 2, createdAt: daysAgo(3) },
					{ meetingId: 2, runId: "b", gateFailures: 1, createdAt: daysAgo(5) },
					{ meetingId: 2, runId: "b", gateFailures: 0, createdAt: daysAgo(5) },
					{
						meetingId: 3,
						runId: "old",
						gateFailures: 1,
						createdAt: daysAgo(60),
					},
				],
				now,
			),
		).toEqual({ meetings: 2, held: 1, rate: 0.5 });
	});

	it("leaves out the operator's release runs, and is 0 with nothing in the window", () => {
		expect(
			holdStats(
				[
					{ meetingId: 1, runId: "a", gateFailures: 1, createdAt: daysAgo(3) },
					{
						meetingId: 1,
						runId: "release-x",
						gateFailures: 0,
						createdAt: daysAgo(1),
					},
				],
				now,
			),
		).toEqual({ meetings: 1, held: 1, rate: 1 });
		expect(holdStats([], now)).toEqual({ meetings: 0, held: 0, rate: 0 });
	});
});
