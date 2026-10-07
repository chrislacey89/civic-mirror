import { describe, expect, it } from "vitest";
import { readVideoTitle } from "#/pipeline/video-title.ts";

const PREFIX = "Ellettsville Town Council";

describe("readVideoTitle", () => {
	it("reads a regular meeting title as its date with an empty session", () => {
		expect(
			readVideoTitle("Ellettsville Town Council, August 25, 2025", PREFIX),
		).toEqual({
			kind: "meeting",
			date: "2025-08-25",
			session: "",
			qualifier: null,
		});
	});

	it("reads a qualifier before the comma as the session slug", () => {
		expect(
			readVideoTitle(
				"Ellettsville Town Council Budget Work Session, August 25, 2025",
				PREFIX,
			),
		).toEqual({
			kind: "meeting",
			date: "2025-08-25",
			session: "budget-work-session",
			qualifier: "Budget Work Session",
		});
	});

	it.each([
		[
			"another body's recording",
			"Ellettsville Plan Commission, August 25, 2025",
		],
		[
			"a longer body name that only begins with the prefix",
			"Ellettsville Town Councilors Retreat, August 25, 2025",
		],
		["no date at all", "Ellettsville Town Council Special Session"],
		["only a numeric date", "Ellettsville Town Council, 08-25-25"],
		[
			"a numeric date in the qualifier and none after the comma",
			"Ellettsville Town Council 08-25-25, Budget Hearing",
		],
		[
			"a day that does not exist",
			"Ellettsville Town Council, February 30, 2025",
		],
		[
			"words after the date",
			"Ellettsville Town Council, August 25, 2025 (Part 2)",
		],
		[
			"a qualifier with no letters or digits",
			"Ellettsville Town Council --, August 25, 2025",
		],
	])("refuses %s", (_case, title) => {
		expect(readVideoTitle(title, PREFIX)).toEqual({ kind: "unrecognized" });
	});
});
