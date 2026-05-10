import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "#/pipeline/scripts/evals/corpus-loader.ts";

const fixtureCorpusDir = (sub: string): string =>
	fileURLToPath(
		new URL(`./__fixtures__/corpus-loader/${sub}/corpus`, import.meta.url),
	);

describe("loadCorpus", () => {
	it("loads a valid corpus entry with transcriptText resolved from disk", async () => {
		const result = await Effect.runPromise(
			loadCorpus(fixtureCorpusDir("valid")),
		);

		expect(result).toHaveLength(1);
		const entry = result[0];
		expect(entry.id).toBe("sample");
		expect(entry.schema_version).toBe(1);
		expect(entry.ground_truth.level).toBe("routine");
		expect(entry.ground_truth.category_scores.procedural_breakdown.score).toBe(
			0,
		);
		expect(entry.transcriptText).toContain("Let's call the meeting to order");
		expect(entry.sourcePath).toMatch(/valid\/corpus\/sample\.json$/);
	});
});
