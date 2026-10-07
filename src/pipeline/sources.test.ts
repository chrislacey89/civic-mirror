import { describe, expect, it } from "vitest";
import {
	computeSourceFingerprint,
	fingerprintOfSources,
	kindsOfReadableSources,
	kindsOfSources,
	kindsOfUnfingerprintedSummary,
	readableSources,
	stampOfUnfingerprintedSummary,
} from "#/pipeline/sources.ts";

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

	// Stored summaries carry this value and are regenerated when it differs, so a
	// change to the hash or encoding must fail here. The literal is the SHA-256 of
	// the sorted, de-duplicated URL list as compact JSON, computed outside the code.
	it("keeps the fingerprint of a fixed URL list stable", () => {
		expect(computeSourceFingerprint([VIDEO, MINUTES, VIDEO])).toBe(
			"03b84711f2e7c7d40fa0140619d1fa11280442a4d1d0185890f2e3fd05e026b3",
		);
	});

	it("is never the empty string that marks a summary with no recorded sources", () => {
		expect(computeSourceFingerprint([])).not.toBe("");
	});
});

describe("fingerprintOfSources", () => {
	it("counts every document URL and the transcript URL", () => {
		expect(
			fingerprintOfSources({
				documents: [{ sourceUrl: MINUTES }],
				transcriptUrl: VIDEO,
			}),
		).toBe(computeSourceFingerprint([MINUTES, VIDEO]));
	});

	it("fingerprints documents alone when there is no transcript", () => {
		const expected = computeSourceFingerprint([MINUTES]);
		expect(fingerprintOfSources({ documents: [{ sourceUrl: MINUTES }] })).toBe(
			expected,
		);
		expect(
			fingerprintOfSources({
				documents: [{ sourceUrl: MINUTES }],
				transcriptUrl: null,
			}),
		).toBe(expected);
	});

	it("fingerprints a transcript alone when there are no documents", () => {
		expect(fingerprintOfSources({ documents: [], transcriptUrl: VIDEO })).toBe(
			computeSourceFingerprint([VIDEO]),
		);
	});
});

describe("readableSources", () => {
	it("labels each source that has text, documents first, and leaves out the blank ones", () => {
		expect(
			readableSources({
				documents: [
					{ rawText: "Agenda." },
					{ rawText: " \n" },
					{ rawText: "Minutes." },
				],
				transcript: { rawText: "Transcript." },
			}),
		).toEqual([
			{ kind: "documents", text: "Agenda." },
			{ kind: "documents", text: "Minutes." },
			{ kind: "transcript", text: "Transcript." },
		]);
	});

	it("is empty when nothing held has text", () => {
		expect(
			readableSources({
				documents: [{ rawText: "" }],
				transcript: { rawText: "  " },
			}),
		).toEqual([]);
		expect(readableSources({ documents: [], transcript: null })).toEqual([]);
	});
});

describe("kindsOfReadableSources", () => {
	it("names each kind once, documents before transcript", () => {
		expect(
			kindsOfReadableSources([
				{ kind: "transcript", text: "Transcript." },
				{ kind: "documents", text: "Agenda." },
				{ kind: "documents", text: "Minutes." },
			]),
		).toEqual(["documents", "transcript"]);
		expect(kindsOfReadableSources([])).toEqual([]);
	});
});

describe("kindsOfSources", () => {
	it("names documents and transcript, in that order, when both have text", () => {
		expect(
			kindsOfSources({
				documents: [{ rawText: "Minutes." }],
				transcript: { rawText: "Transcript." },
			}),
		).toEqual(["documents", "transcript"]);
	});

	it("names only the transcript when the meeting holds no documents", () => {
		expect(
			kindsOfSources({ documents: [], transcript: { rawText: "Transcript." } }),
		).toEqual(["transcript"]);
	});

	it("names only the documents when there is no transcript", () => {
		expect(
			kindsOfSources({
				documents: [{ rawText: "Minutes." }],
				transcript: null,
			}),
		).toEqual(["documents"]);
	});

	it("does not count a kind whose text is all blank", () => {
		expect(
			kindsOfSources({
				documents: [{ rawText: "  " }, { rawText: "" }],
				transcript: { rawText: "Transcript." },
			}),
		).toEqual(["transcript"]);
		expect(
			kindsOfSources({
				documents: [{ rawText: "" }, { rawText: "Minutes." }],
				transcript: { rawText: "\n" },
			}),
		).toEqual(["documents"]);
	});
});

describe("kindsOfUnfingerprintedSummary", () => {
	it("names only the documents when the meeting also holds a transcript", () => {
		expect(
			kindsOfUnfingerprintedSummary({
				documents: [{ rawText: "Minutes." }],
				transcript: { rawText: "Transcript." },
			}),
		).toEqual(["documents"]);
	});

	it("names the transcript when no document has text", () => {
		expect(
			kindsOfUnfingerprintedSummary({
				documents: [{ rawText: " " }],
				transcript: { rawText: "Transcript." },
			}),
		).toEqual(["transcript"]);
	});
});

describe("stampOfUnfingerprintedSummary", () => {
	it("fingerprints every source held and names only the documents when a transcript sits beside them", () => {
		expect(
			stampOfUnfingerprintedSummary({
				documents: [{ sourceUrl: MINUTES, rawText: "Minutes." }],
				transcript: { sourceUrl: VIDEO, rawText: "Transcript." },
			}),
		).toEqual({
			sourceFingerprint: computeSourceFingerprint([MINUTES, VIDEO]),
			sourceKinds: ["documents"],
		});
	});

	it("names only the documents when the transcript beside them has no URL", () => {
		expect(
			stampOfUnfingerprintedSummary({
				documents: [{ sourceUrl: MINUTES, rawText: "Minutes." }],
				transcript: { sourceUrl: null, rawText: "Transcript." },
			}),
		).toEqual({
			sourceFingerprint: computeSourceFingerprint([MINUTES]),
			sourceKinds: ["documents"],
		});
	});

	it("names the transcript when no document held has text", () => {
		expect(
			stampOfUnfingerprintedSummary({
				documents: [{ sourceUrl: MINUTES, rawText: "" }],
				transcript: { sourceUrl: VIDEO, rawText: "Transcript." },
			}),
		).toEqual({
			sourceFingerprint: computeSourceFingerprint([MINUTES, VIDEO]),
			sourceKinds: ["transcript"],
		});
	});

	it("stamps a summary as the transcript's alone, whatever documents the meeting is about to take", () => {
		expect(
			stampOfUnfingerprintedSummary({ transcriptAlone: { sourceUrl: VIDEO } }),
		).toEqual({
			sourceFingerprint: computeSourceFingerprint([VIDEO]),
			sourceKinds: ["transcript"],
		});
		expect(
			stampOfUnfingerprintedSummary({ transcriptAlone: { sourceUrl: null } }),
		).toEqual({
			sourceFingerprint: computeSourceFingerprint([]),
			sourceKinds: ["transcript"],
		});
	});
});
