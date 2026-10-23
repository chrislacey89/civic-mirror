import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	CorpusLoadError,
	loadCorpus,
} from "#/pipeline/scripts/evals/corpus-loader.ts";

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

	it("rejects a corpus entry whose transcript file is missing", async () => {
		const exit = await Effect.runPromiseExit(
			loadCorpus(fixtureCorpusDir("missing-transcript")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("CorpusLoadError");
			expect(err).toContain("transcript file not found");
		}
	});

	it("rejects a corpus entry missing one of the 7 canonical category keys", async () => {
		const exit = await Effect.runPromiseExit(
			loadCorpus(fixtureCorpusDir("missing-category")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("CorpusLoadError");
			expect(err).toContain("post_hoc_corrections");
		}
	});

	it("rejects a corpus entry with a non-canonical extra category key", async () => {
		const exit = await Effect.runPromiseExit(
			loadCorpus(fixtureCorpusDir("extra-category")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("CorpusLoadError");
			expect(err).toContain("weather_disruption");
		}
	});

	it("rejects malformed JSON with a useful error", async () => {
		const exit = await Effect.runPromiseExit(
			loadCorpus(fixtureCorpusDir("malformed")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("CorpusLoadError");
			expect(err).toContain("malformed JSON");
		}
	});

	it("rejects a corpus entry with a non-1 schema_version", async () => {
		const exit = await Effect.runPromiseExit(
			loadCorpus(fixtureCorpusDir("schema-version-mismatch")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("CorpusLoadError");
		}
	});

	it("rejects a non-existent corpus directory", async () => {
		const missingDir = fileURLToPath(
			new URL("./__fixtures__/corpus-loader/does-not-exist", import.meta.url),
		);
		const exit = await Effect.runPromiseExit(loadCorpus(missingDir));

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("CorpusLoadError");
		}
	});

	it("CorpusLoadError is a tagged error", () => {
		const err = new CorpusLoadError({ message: "x", path: "y" });
		expect(err._tag).toBe("CorpusLoadError");
		expect(err.message).toBe("x");
		expect(err.path).toBe("y");
	});
});
