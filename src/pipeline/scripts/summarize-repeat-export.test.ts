import { describe, expect, it } from "vitest";
import { compareImport } from "./summarize-repeat-export.ts";

describe("compareImport", () => {
	it("keys each finished run's highlights and prose under the meeting date, in the compare page's import shape", () => {
		const out = compareImport("2026-05-26", "gemini-2.5-flash", [
			{
				summary: {
					fiscalDecisions: [],
					highlights: ["Council accepts paving bid"],
					prose: "Milestone was the lowest bidder.",
				},
			},
			{ failure: "model timed out" },
			{
				summary: {
					fiscalDecisions: [],
					highlights: ["Council accepts paving bid", "Parcels rezoned"],
					prose:
						"Milestone was the lowest bidder.\n\nTwo parcels were rezoned.",
				},
			},
		]);

		expect(out).toEqual({
			"2026-05-26": {
				"gemini-2.5-flash run 1": {
					highlights: ["Council accepts paving bid"],
					prose: "Milestone was the lowest bidder.",
				},
				"gemini-2.5-flash run 3": {
					highlights: ["Council accepts paving bid", "Parcels rezoned"],
					prose:
						"Milestone was the lowest bidder.\n\nTwo parcels were rezoned.",
				},
			},
		});
	});
});
