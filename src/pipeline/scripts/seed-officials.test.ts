import { describe, expect, it } from "vitest";
import { officialCandidates } from "./seed-officials.ts";

const meeting = (date: string, text: string) => ({ date, text });

describe("officialCandidates", () => {
	const minutes = [
		meeting("2025-01-13", "Town Manager Ada Lovelace reported. Bo Reed spoke."),
		meeting("2025-02-10", "Ada Lovelace, Town Manager, reported."),
		meeting(
			"2025-03-10",
			"Mx. Lovelace left. Town Manager Ada Lovelace stayed.",
		),
	];

	it("lists a name in at least the given number of meetings, with the dates it was seen and the roles beside it", () => {
		expect(officialCandidates(minutes, 2)).toEqual([
			{
				name: "Ada Lovelace",
				meetings: 3,
				first: "2025-01-13",
				last: "2025-03-10",
				roles: ["Town Manager"],
			},
		]);
	});

	it("leaves out a name in fewer meetings", () => {
		expect(officialCandidates(minutes, 4)).toEqual([]);
	});
});
