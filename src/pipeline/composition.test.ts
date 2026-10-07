import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildProductionLayers,
	parseSourcesFlag,
	requireEnv,
} from "#/pipeline/composition.ts";
import { TranscriptionService } from "#/pipeline/services/TranscriptionService.ts";

const { fetchTranscript, execFileSync } = vi.hoisted(() => ({
	fetchTranscript: vi.fn(),
	execFileSync: vi.fn(),
}));

vi.mock("youtube-transcript", () => ({
	YoutubeTranscript: { fetchTranscript },
	YoutubeTranscriptDisabledError: class extends Error {},
}));
vi.mock("node:child_process", () => ({ execFileSync }));

const TOUCHED = ["CM_TEST_PRIMARY", "CM_TEST_ALIAS"] as const;

afterEach(() => {
	for (const name of TOUCHED) delete process.env[name];
});

describe("requireEnv", () => {
	it("returns the primary variable when it is set", () => {
		process.env.CM_TEST_PRIMARY = "primary-value";
		process.env.CM_TEST_ALIAS = "alias-value";

		expect(requireEnv("CM_TEST_PRIMARY", "CM_TEST_ALIAS")).toBe(
			"primary-value",
		);
	});

	it("falls back to an alias when the primary is unset", () => {
		process.env.CM_TEST_ALIAS = "alias-value";

		expect(requireEnv("CM_TEST_PRIMARY", "CM_TEST_ALIAS")).toBe("alias-value");
	});

	it("treats an empty primary as unset and falls back to the alias", () => {
		process.env.CM_TEST_PRIMARY = "";
		process.env.CM_TEST_ALIAS = "alias-value";

		expect(requireEnv("CM_TEST_PRIMARY", "CM_TEST_ALIAS")).toBe("alias-value");
	});

	it("names every accepted variable when none is set", () => {
		expect(() => requireEnv("CM_TEST_PRIMARY", "CM_TEST_ALIAS")).toThrow(
			/Missing required environment variable: CM_TEST_PRIMARY or CM_TEST_ALIAS\./,
		);
	});

	it("still names a single variable when called without aliases", () => {
		expect(() => requireEnv("CM_TEST_PRIMARY")).toThrow(
			/Missing required environment variable: CM_TEST_PRIMARY\./,
		);
	});
});

describe("parseSourcesFlag", () => {
	it("reads a comma-separated list, ignoring spaces and repeats", () => {
		expect(parseSourcesFlag("youtube, egov,youtube")).toEqual({
			ok: true,
			sources: ["youtube", "egov"],
		});
	});

	it("names every entry that is not a source path", () => {
		expect(parseSourcesFlag("youtube,vimeo,pdf")).toEqual({
			ok: false,
			unknown: ["vimeo", "pdf"],
		});
	});

	it("refuses a list with nothing in it", () => {
		expect(parseSourcesFlag(" , ")).toEqual({ ok: false, unknown: [] });
	});
});

describe("buildProductionLayers transcription", () => {
	it("surfaces a caption failure without falling back to Whisper", async () => {
		vi.stubEnv("DATABASE_URL", "file::memory:");
		fetchTranscript.mockRejectedValue(new Error("captions blocked"));

		const layers = buildProductionLayers({ dryRun: true });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const transcription = yield* TranscriptionService;
				return yield* Effect.flip(transcription.transcribe("abc123"));
			}).pipe(Effect.provide(layers)),
		);

		expect(result.message).toBe("captions blocked");
		expect(execFileSync).not.toHaveBeenCalled();
		vi.unstubAllEnvs();
	});
});
