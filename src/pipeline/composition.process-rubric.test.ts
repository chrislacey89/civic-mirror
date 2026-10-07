import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAMA_CATEGORIES } from "#/lib/drama-levels.ts";
import { buildProductionLayers } from "#/pipeline/composition.ts";
import { DramaDetectionService } from "#/pipeline/services/DramaDetectionService.ts";
import { formatTranscriptWithTimestamps } from "#/pipeline/services/transcriptFormatting.ts";

const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText,
}));

afterEach(() => {
	vi.unstubAllEnvs();
	generateText.mockReset();
});

/** Category keys a rubric prompt gives a numbered `## N. key` section. */
function rubricCategories(prompt: string): string[] {
	return [...prompt.matchAll(/^## \d+\. (\w+)$/gm)].map((m) => m[1]);
}

describe("buildProductionLayers process rubric", () => {
	it("sends the model a rubric for the categories the detector scores", async () => {
		vi.stubEnv("DATABASE_URL", "file::memory:");
		generateText.mockResolvedValue({
			output: {
				category_scores: Object.fromEntries(
					DRAMA_CATEGORIES.map((c) => [c, { score: 0, evidence_quotes: [] }]),
				),
				level: "routine",
				confidence: 0.9,
				headline: "Council approves the consent agenda 5–0",
				narrative: "Nothing notable.",
			},
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const detector = yield* DramaDetectionService;
				return yield* detector.detect({
					// The shape production sends: captions-only transcript, offsets
					// only in `segments`, formatted by the orchestrator.
					sourceText: formatTranscriptWithTimestamps({
						source: "captions",
						rawText: "Call to order. Roll call.",
						segments: [
							{ text: "Call to order.", startMs: 0, durationMs: 2000 },
							{ text: "Roll call.", startMs: 45000, durationMs: 2000 },
						],
					}),
					meetingContext: "Town Council, regular meeting",
				});
			}).pipe(Effect.provide(buildProductionLayers({ dryRun: true }))),
		);

		const { system } = generateText.mock.calls[0][0] as { system: string };
		expect(rubricCategories(system)).toEqual([...DRAMA_CATEGORIES]);
		expect(system).not.toMatch(/drama/i);
		const { prompt } = generateText.mock.calls[0][0] as { prompt: string };
		expect(prompt).toContain("[00:00] Call to order. [00:45] Roll call.");
		expect(result.promptVersion).toBe("v2");
	});
});
