import { describe, expect, it } from "vitest";
import { parseReleaseFile } from "#/pipeline/summaryHolds.ts";

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
