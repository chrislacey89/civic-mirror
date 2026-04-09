import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
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
});
