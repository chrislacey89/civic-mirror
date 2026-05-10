import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	loadProfiles,
	ProfileLoadError,
} from "#/pipeline/scripts/evals/profile-loader.ts";

const fixtureDir = (sub: string): string =>
	fileURLToPath(
		new URL(`./__fixtures__/profile-loader/${sub}`, import.meta.url),
	);

describe("loadProfiles", () => {
	it("loads every *.ts profile under the directory and surfaces sourcePath", async () => {
		const result = await Effect.runPromise(loadProfiles(fixtureDir("valid")));

		expect(result.map((p) => p.promptVersion).sort()).toEqual(["v1", "v2"]);
		const v1 = result.find((p) => p.promptVersion === "v1");
		expect(v1).toBeDefined();
		expect(v1?.systemPrompt).toContain("Score this meeting");
		expect(v1?.thinkingBudget).toBe(4096);
		expect(v1?.includeThoughts).toBe(true);
		expect(v1?.sourcePath).toMatch(/valid\/v1\.ts$/);
	});

	it("rejects an empty systemPrompt with ProfileLoadError", async () => {
		const exit = await Effect.runPromiseExit(
			loadProfiles(fixtureDir("empty-prompt")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("ProfileLoadError");
			expect(err).toContain("systemPrompt");
		}
	});

	it("rejects a whitespace-only systemPrompt with ProfileLoadError", async () => {
		const exit = await Effect.runPromiseExit(
			loadProfiles(fixtureDir("whitespace-prompt")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("ProfileLoadError");
		}
	});

	it("rejects two profiles with the same promptVersion", async () => {
		const exit = await Effect.runPromiseExit(
			loadProfiles(fixtureDir("duplicates")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const err = exit.cause.toString();
			expect(err).toContain("ProfileLoadError");
			expect(err).toContain("vdup");
		}
	});

	it("rejects a profile whose optional field has the wrong type", async () => {
		const exit = await Effect.runPromiseExit(
			loadProfiles(fixtureDir("bad-optional-types")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("ProfileLoadError");
		}
	});

	it("rejects a non-existent directory", async () => {
		const exit = await Effect.runPromiseExit(
			loadProfiles(fixtureDir("does-not-exist")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("ProfileLoadError");
		}
	});

	it("ProfileLoadError is a tagged error", () => {
		const err = new ProfileLoadError({ message: "x", path: "y" });
		expect(err._tag).toBe("ProfileLoadError");
		expect(err.message).toBe("x");
		expect(err.path).toBe("y");
	});
});
