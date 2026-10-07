import { describe, expect, it } from "vitest";
import { formatHeldVideoLine } from "./held.ts";

describe("formatHeldVideoLine", () => {
	const base = {
		bodySlug: "ellettsville-town-council",
		videoId: "1aK9vZNPH7I",
		title: "Ellettsville Town Council, March 23, 2026",
		meetingDate: "2026-03-23",
		reason: "no-captions" as const,
		createdAt: new Date(0),
	};

	it("prints the video ID, meeting date, reason and title on one line, with - for the check fields a hold did not go through", () => {
		expect(formatHeldVideoLine(base)).toBe(
			"1aK9vZNPH7I  2026-03-23  no-captions         p=-     shared=-  Ellettsville Town Council, March 23, 2026",
		);
	});

	it("prints the probability and shared-identifier count of a hold from the same-meeting check, and - for an unreadable date", () => {
		expect(
			formatHeldVideoLine({
				...base,
				meetingDate: null,
				reason: "signals-disagree",
				probability: 0.8,
				sharedIdentifiers: 0,
			}),
		).toBe(
			"1aK9vZNPH7I  -           signals-disagree    p=0.80  shared=0  Ellettsville Town Council, March 23, 2026",
		);
	});
});
