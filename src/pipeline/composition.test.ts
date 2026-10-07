import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YoutubeTranscriptDisabledError } from "youtube-transcript";

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

vi.mock("youtube-transcript", async (importOriginal) => ({
	...(await importOriginal<typeof import("youtube-transcript")>()),
	YoutubeTranscript: { fetchTranscript },
}));
vi.mock("node:child_process", () => ({ execFileSync }));

const TOUCHED = ["CM_TEST_PRIMARY", "CM_TEST_ALIAS"] as const;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
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

	describe("when the library reports captions disabled", () => {
		const videoId = "abc123DEF45";
		const watchPage = (playerResponse: unknown) =>
			`<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
		const playableResponse = {
			playabilityStatus: { status: "OK" },
			videoDetails: { videoId, title: "Council meeting" },
			streamingData: { formats: [] },
		};

		const transcribeWithWatchPage = async (
			playerResponse: unknown,
			status = 200,
		) => {
			vi.stubEnv("DATABASE_URL", "file::memory:");
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(watchPage(playerResponse), { status })),
			);
			fetchTranscript.mockRejectedValue(
				new YoutubeTranscriptDisabledError(videoId),
			);

			const layers = buildProductionLayers({ dryRun: true });
			return Effect.runPromise(
				Effect.gen(function* () {
					const transcription = yield* TranscriptionService;
					return yield* Effect.flip(transcription.transcribe(videoId));
				}).pipe(Effect.provide(layers)),
			);
		};

		it("flags captionsDisabled when the watch page confirms a playable video without tracks", async () => {
			const result = await transcribeWithWatchPage(playableResponse);

			expect(result.captionsDisabled).toBe(true);
			expect(execFileSync).not.toHaveBeenCalled();
		});

		it("fails as an ordinary error when the watch page does not confirm it", async () => {
			const result = await transcribeWithWatchPage({
				...playableResponse,
				captions: {
					playerCaptionsTracklistRenderer: {
						captionTracks: [{ languageCode: "en" }],
					},
				},
			});

			expect(result.captionsDisabled).toBeFalsy();
			expect(result.message).toContain("captions disabled not confirmed");
			expect(execFileSync).not.toHaveBeenCalled();
		});

		it("does not flag captionsDisabled when the watch page responds with a non-2xx status", async () => {
			const result = await transcribeWithWatchPage(playableResponse, 429);

			expect(result.captionsDisabled).toBeFalsy();
			expect(execFileSync).not.toHaveBeenCalled();
		});
	});
});
