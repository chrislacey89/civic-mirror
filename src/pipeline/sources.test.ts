import { describe, expect, it } from "vitest";
import { computeSourceFingerprint } from "#/pipeline/sources.ts";

const MINUTES = "https://ellettsville.in.us/egov/docs/123.pdf";
const VIDEO = "https://www.youtube.com/watch?v=abc123";

describe("computeSourceFingerprint", () => {
	it("gives the same fingerprint for the same sources in any order", () => {
		expect(computeSourceFingerprint([MINUTES, VIDEO])).toBe(
			computeSourceFingerprint([VIDEO, MINUTES]),
		);
	});

	it("changes when a source is added", () => {
		expect(computeSourceFingerprint([VIDEO])).not.toBe(
			computeSourceFingerprint([VIDEO, MINUTES]),
		);
	});

	it("does not count a source listed twice as a change", () => {
		expect(computeSourceFingerprint([VIDEO, VIDEO])).toBe(
			computeSourceFingerprint([VIDEO]),
		);
	});

	it("tells two URLs from one URL that contains both", () => {
		expect(computeSourceFingerprint(["a", "b"])).not.toBe(
			computeSourceFingerprint(["a\nb"]),
		);
	});

	it("is never the empty string that marks a summary with no recorded sources", () => {
		expect(computeSourceFingerprint([])).not.toBe("");
	});
});
