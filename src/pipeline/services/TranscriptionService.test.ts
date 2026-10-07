import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	CaptionTracksMissingError,
	readCaptionsDisabled,
	TranscriptionService,
	TranscriptionServiceLive,
	WhisperLocalProviderLive,
	YouTubeCaptionProviderLive,
} from "./TranscriptionService.ts";

/**
 * Effect teaching note: These tests demonstrate how to test Effect services
 * with injected dependencies. The youtube-transcript and whisper.cpp calls
 * are replaced with mock functions, keeping tests fast and deterministic.
 */

const mockCaptionSegments = [
	{ text: "Meeting called to order.", duration: 3000, offset: 0 },
	{ text: "Motion to approve road repairs.", duration: 4000, offset: 3000 },
];

describe("TranscriptionService", () => {
	describe("YouTubeCaptionProvider", () => {
		it("extracts captions from a video and returns TranscriptResult", async () => {
			const mockFetchTranscript = async () => mockCaptionSegments;

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("test-video-id");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: mockFetchTranscript,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.source).toBe("captions");
			expect(result.rawText).toBe(
				"Meeting called to order. Motion to approve road repairs.",
			);
			expect(result.segments).toHaveLength(2);
			expect(result.segments[0]).toEqual({
				text: "Meeting called to order.",
				startMs: 0,
				durationMs: 3000,
			});
		});

		it("converts classic-format offsets from seconds to milliseconds", async () => {
			const classicSegments = [
				{ text: "Meeting called to order.", duration: 3.5, offset: 0 },
				{ text: "Motion to approve.", duration: 4, offset: 3.5 },
				{ text: "Second.", duration: 2.25, offset: 7200 },
			];

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("classic-video-id");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: async () => classicSegments,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.segments.map((s) => s.startMs)).toEqual([0, 3500, 7200000]);
			expect(result.segments.map((s) => s.durationMs)).toEqual([
				3500, 4000, 2250,
			]);
		});

		it("does not rescale integer millisecond offsets", async () => {
			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("srv3-video-id");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: async () => [
							{ text: "Opening.", duration: 2500, offset: 1000 },
							{ text: "Closing.", duration: 4000, offset: 7200000 },
						],
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.segments.map((s) => s.startMs)).toEqual([1000, 7200000]);
			expect(result.segments.map((s) => s.durationMs)).toEqual([2500, 4000]);
		});

		it("maps youtube-transcript errors to TranscriptionError", async () => {
			const mockFetchTranscript = async () => {
				throw new Error("Transcript not available");
			};

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("no-captions-video");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: mockFetchTranscript,
					}),
				),
			);

			const result = await Effect.runPromiseExit(program);
			expect(result._tag).toBe("Failure");
		});

		it.each([
			["no segments", []],
			[
				"whitespace-only segments",
				[
					{ text: "  ", duration: 1000, offset: 0 },
					{ text: "\n", duration: 1000, offset: 1000 },
				],
			],
		])("fails with TranscriptionError when captions have %s", async (_name, segments) => {
			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("empty-captions-video");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: async () => segments,
					}),
				),
			);

			const error = await Effect.runPromise(Effect.flip(program));
			expect(error._tag).toBe("TranscriptionError");
			expect(error.message).toBe("Captions came back empty");
			expect(error.captionsDisabled).toBeUndefined();
		});

		describe("when the fetch reports no caption tracks", () => {
			const runProvider = (
				fetchTranscriptFn: () => Promise<
					{ text: string; duration: number; offset: number }[]
				>,
				confirmCaptionsDisabledFn: (videoId: string) => Promise<boolean>,
			) =>
				Effect.gen(function* () {
					const service = yield* TranscriptionService;
					return yield* service.transcribe("no-tracks-video");
				}).pipe(
					Effect.provide(
						YouTubeCaptionProviderLive({
							fetchTranscriptFn,
							confirmCaptionsDisabledFn,
						}),
					),
				);
			const reportNoTracks = async () => {
				throw new CaptionTracksMissingError("no-tracks-video");
			};

			it("flags captionsDisabled when the watch page confirms it", async () => {
				const confirmedIds: string[] = [];
				const error = await Effect.runPromise(
					Effect.flip(
						runProvider(reportNoTracks, async (videoId) => {
							confirmedIds.push(videoId);
							return true;
						}),
					),
				);

				expect(error._tag).toBe("TranscriptionError");
				expect(error.videoId).toBe("no-tracks-video");
				expect(error.captionsDisabled).toBe(true);
				expect(confirmedIds).toEqual(["no-tracks-video"]);
			});

			it("stays an ordinary failure when the watch page does not confirm it", async () => {
				const error = await Effect.runPromise(
					Effect.flip(runProvider(reportNoTracks, async () => false)),
				);

				expect(error._tag).toBe("TranscriptionError");
				expect(error.captionsDisabled).toBeUndefined();
				expect(error.message).toContain("not confirmed");
			});

			it("stays an ordinary failure when the confirmation itself fails", async () => {
				const error = await Effect.runPromise(
					Effect.flip(
						runProvider(reportNoTracks, async () => {
							throw new Error("watch page fetch failed");
						}),
					),
				);

				expect(error._tag).toBe("TranscriptionError");
				expect(error.captionsDisabled).toBeUndefined();
				expect(error.message).toContain("not confirmed");
			});
		});

		it("does not ask for confirmation when the fetch fails for another reason", async () => {
			let confirmCalled = false;
			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("flaky-video");
			}).pipe(
				Effect.provide(
					YouTubeCaptionProviderLive({
						fetchTranscriptFn: async () => {
							throw new Error("Too many requests");
						},
						confirmCaptionsDisabledFn: async () => {
							confirmCalled = true;
							return true;
						},
					}),
				),
			);

			const error = await Effect.runPromise(Effect.flip(program));
			expect(error.message).toBe("Too many requests");
			expect(error.captionsDisabled).toBeUndefined();
			expect(confirmCalled).toBe(false);
		});
	});

	describe("WhisperLocalProvider", () => {
		it("transcribes audio via whisper.cpp and returns TranscriptResult", async () => {
			const mockWhisperSegments = [
				{ text: "The council discussed budget.", startMs: 0, durationMs: 5000 },
				{
					text: "Motion carried unanimously.",
					startMs: 5000,
					durationMs: 3000,
				},
			];

			const mockRunWhisper = async () => ({
				rawText: "The council discussed budget. Motion carried unanimously.",
				segments: mockWhisperSegments,
			});

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("whisper-video-id");
			}).pipe(
				Effect.provide(
					WhisperLocalProviderLive({ runWhisperFn: mockRunWhisper }),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.source).toBe("whisper");
			expect(result.rawText).toContain("council discussed budget");
			expect(result.segments).toHaveLength(2);
		});

		it("maps whisper.cpp errors to TranscriptionError", async () => {
			const mockRunWhisper = async () => {
				throw new Error("whisper.cpp process exited with code 1");
			};

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("bad-audio-id");
			}).pipe(
				Effect.provide(
					WhisperLocalProviderLive({ runWhisperFn: mockRunWhisper }),
				),
			);

			const result = await Effect.runPromiseExit(program);
			expect(result._tag).toBe("Failure");
		});
	});

	describe("Fallback chain", () => {
		it("uses captions when available, skips Whisper", async () => {
			let whisperCalled = false;
			const mockFetchTranscript = async () => mockCaptionSegments;
			const mockRunWhisper = async () => {
				whisperCalled = true;
				return { rawText: "whisper output", segments: [] };
			};

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("has-captions");
			}).pipe(
				Effect.provide(
					TranscriptionServiceLive({
						fetchTranscriptFn: mockFetchTranscript,
						runWhisperFn: mockRunWhisper,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.source).toBe("captions");
			expect(whisperCalled).toBe(false);
		});

		it("falls back to Whisper when captions fail", async () => {
			const mockFetchTranscript = async () => {
				throw new Error("No captions available");
			};
			const mockRunWhisper = async () => ({
				rawText: "Whisper transcribed this.",
				segments: [
					{ text: "Whisper transcribed this.", startMs: 0, durationMs: 4000 },
				],
			});

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("no-captions-video");
			}).pipe(
				Effect.provide(
					TranscriptionServiceLive({
						fetchTranscriptFn: mockFetchTranscript,
						runWhisperFn: mockRunWhisper,
					}),
				),
			);

			const result = await Effect.runPromise(program);

			expect(result.source).toBe("whisper");
			expect(result.rawText).toBe("Whisper transcribed this.");
		});

		it("falls back to Whisper when captions come back empty", async () => {
			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("empty-captions-video");
			}).pipe(
				Effect.provide(
					TranscriptionServiceLive({
						fetchTranscriptFn: async () => [],
						runWhisperFn: async () => ({
							rawText: "Whisper transcribed this.",
							segments: [
								{
									text: "Whisper transcribed this.",
									startMs: 0,
									durationMs: 4000,
								},
							],
						}),
					}),
				),
			);

			const result = await Effect.runPromise(program);
			expect(result.source).toBe("whisper");
		});

		it("fails with TranscriptionError when both providers fail", async () => {
			const mockFetchTranscript = async () => {
				throw new Error("No captions");
			};
			const mockRunWhisper = async () => {
				throw new Error("Whisper crashed");
			};

			const program = Effect.gen(function* () {
				const service = yield* TranscriptionService;
				return yield* service.transcribe("impossible-video");
			}).pipe(
				Effect.provide(
					TranscriptionServiceLive({
						fetchTranscriptFn: mockFetchTranscript,
						runWhisperFn: mockRunWhisper,
					}),
				),
			);

			const result = await Effect.runPromiseExit(program);
			expect(result._tag).toBe("Failure");
		});
	});

	describe("readCaptionsDisabled", () => {
		const videoId = "abc123DEF45";
		const watchPage = (playerResponse: unknown) =>
			`<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
		const playableResponse = {
			playabilityStatus: { status: "OK" },
			videoDetails: { videoId, title: "Meeting {draft}" },
			streamingData: { formats: [] },
		};

		it("is true when the video is playable and has no caption tracks", () => {
			expect(readCaptionsDisabled(watchPage(playableResponse), videoId)).toBe(
				true,
			);
		});

		it("is true when the caption track list is empty", () => {
			const response = {
				...playableResponse,
				captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(true);
		});

		it("is true when the description contains escaped quotes and a closing brace", () => {
			const response = {
				...playableResponse,
				videoDetails: {
					...playableResponse.videoDetails,
					shortDescription:
						'Motion to "adjourn}" carried. Minutes: C:\\clerk\\',
				},
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(true);
		});

		it("is false when the video has caption tracks", () => {
			const response = {
				...playableResponse,
				captions: {
					playerCaptionsTracklistRenderer: {
						captionTracks: [{ baseUrl: "https://example.test/c" }],
					},
				},
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(false);
		});

		it("is false when the video is unavailable", () => {
			const response = { playabilityStatus: { status: "ERROR" } };
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(false);
		});

		it("is false when YouTube demands a login and sends no streaming data", () => {
			const response = {
				playabilityStatus: { status: "LOGIN_REQUIRED" },
				videoDetails: { videoId },
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(false);
		});

		it("is false when the page is playable but sends no streaming data", () => {
			const response = {
				playabilityStatus: { status: "OK" },
				videoDetails: { videoId },
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(false);
		});

		it("is false when the page describes a different video", () => {
			const response = {
				...playableResponse,
				videoDetails: { videoId: "someOtherVid" },
			};
			expect(readCaptionsDisabled(watchPage(response), videoId)).toBe(false);
		});

		it("is false when the page has no player response", () => {
			expect(readCaptionsDisabled("<html>consent wall</html>", videoId)).toBe(
				false,
			);
		});

		it("is false when the player response is not valid JSON", () => {
			expect(
				readCaptionsDisabled(
					"<script>var ytInitialPlayerResponse = {oops};</script>",
					videoId,
				),
			).toBe(false);
		});
	});
});
