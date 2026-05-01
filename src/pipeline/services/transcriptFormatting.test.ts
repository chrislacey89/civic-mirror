import { describe, expect, it } from "vitest";
import { formatTranscriptWithTimestamps } from "./transcriptFormatting";

describe("formatTranscriptWithTimestamps", () => {
	describe("YouTube captions (passthrough)", () => {
		it("passes through rawText unchanged for captions source", () => {
			const input = {
				source: "captions" as const,
				rawText: "This is the meeting transcript",
				segments: [],
			};

			const result = formatTranscriptWithTimestamps(input);

			expect(result).toBe("This is the meeting transcript");
		});

		it("preserves inline MM:SS markers in caption rawText", () => {
			const input = {
				source: "captions" as const,
				rawText: "Opening remarks [00:15] Budget discussion [01:30] Vote",
				segments: [],
			};

			const result = formatTranscriptWithTimestamps(input);

			expect(result).toBe(
				"Opening remarks [00:15] Budget discussion [01:30] Vote",
			);
		});
	});

	describe("Whisper segments (reconstruction)", () => {
		it("reconstructs transcript with MM:SS markers from segments", () => {
			const input = {
				source: "whisper" as const,
				rawText:
					"Opening remarks Budget discussion Vote approval Chair calls order",
				segments: [
					{ text: "Opening remarks", startMs: 0, durationMs: 1000 },
					{ text: "Budget discussion", startMs: 15000, durationMs: 2000 },
					{ text: "Vote approval", startMs: 90000, durationMs: 1000 },
					{
						text: "Chair calls order",
						startMs: 300000,
						durationMs: 500,
					},
				],
			};

			const result = formatTranscriptWithTimestamps(input);

			expect(result).toContain("[00:00]");
			expect(result).toContain("[00:15]");
			expect(result).toContain("[01:30]");
			expect(result).toContain("[05:00]");
		});

		it("handles empty segments array", () => {
			const input = {
				source: "whisper" as const,
				rawText: "Some transcript text",
				segments: [],
			};

			const result = formatTranscriptWithTimestamps(input);

			expect(result).toBe("Some transcript text");
		});

		it("reconstructs accurately with segments at various timestamps", () => {
			const input = {
				source: "whisper" as const,
				rawText: "Quick mention Extended discussion Final thoughts",
				segments: [
					{ text: "Quick mention", startMs: 5000, durationMs: 1000 },
					{ text: "Extended discussion", startMs: 35000, durationMs: 5000 },
					{ text: "Final thoughts", startMs: 125000, durationMs: 2000 },
				],
			};

			const result = formatTranscriptWithTimestamps(input);

			expect(result).toContain("[00:05]");
			expect(result).toContain("[00:35]");
			expect(result).toContain("[02:05]");
		});
	});
});
