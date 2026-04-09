import { Context, Effect, Layer } from "effect";
import { TranscriptionError } from "#/pipeline/errors.ts";

/**
 * Effect teaching note: This module demonstrates the "multiple implementations
 * behind one Tag" pattern. TranscriptionService is a single Context.Tag with
 * two possible providers: YouTubeCaptionProvider (free, instant) and
 * WhisperLocalProvider (local whisper.cpp). The fallback chain composes them
 * using Effect.catchTag — try captions first, fall back to Whisper if that fails.
 * Callers depend only on TranscriptionService, never on a specific provider.
 */

type TranscriptSegment = {
	text: string;
	startMs: number;
	durationMs: number;
};

type TranscriptResult = {
	source: "captions" | "whisper";
	rawText: string;
	segments: TranscriptSegment[];
};

interface TranscriptionServiceInterface {
	transcribe(
		videoId: string,
	): Effect.Effect<TranscriptResult, TranscriptionError>;
}

class TranscriptionService extends Context.Tag("TranscriptionService")<
	TranscriptionService,
	TranscriptionServiceInterface
>() {}

// ---------------------------------------------------------------------------
// YouTubeCaptionProvider
// ---------------------------------------------------------------------------

type CaptionSegment = { text: string; duration: number; offset: number };

type YouTubeCaptionProviderConfig = {
	fetchTranscriptFn?: (videoId: string) => Promise<CaptionSegment[]>;
};

/**
 * Effect teaching note: The fetchTranscriptFn injection follows the same
 * pattern as YouTubeScraper's fetchFn — accept a function parameter so tests
 * can substitute a mock, while production uses the real youtube-transcript call.
 */
function YouTubeCaptionProviderLive(config: YouTubeCaptionProviderConfig = {}) {
	const fetchTranscript = config.fetchTranscriptFn ?? defaultFetchTranscript;

	return Layer.succeed(TranscriptionService, {
		transcribe: (videoId) =>
			Effect.tryPromise({
				try: async () => {
					const segments = await fetchTranscript(videoId);
					const rawText = segments.map((s) => s.text).join(" ");
					return {
						source: "captions" as const,
						rawText,
						segments: segments.map((s) => ({
							text: s.text,
							startMs: s.offset,
							durationMs: s.duration,
						})),
					};
				},
				catch: (error) =>
					new TranscriptionError({
						videoId,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

async function defaultFetchTranscript(
	videoId: string,
): Promise<CaptionSegment[]> {
	const { YoutubeTranscript } = await import("youtube-transcript");
	return YoutubeTranscript.fetchTranscript(videoId);
}

// ---------------------------------------------------------------------------
// WhisperLocalProvider
// ---------------------------------------------------------------------------

type WhisperResult = {
	rawText: string;
	segments: TranscriptSegment[];
};

type WhisperLocalProviderConfig = {
	runWhisperFn?: (videoId: string) => Promise<WhisperResult>;
};

function WhisperLocalProviderLive(config: WhisperLocalProviderConfig = {}) {
	const runWhisper = config.runWhisperFn ?? defaultRunWhisper;

	return Layer.succeed(TranscriptionService, {
		transcribe: (videoId) =>
			Effect.tryPromise({
				try: async () => {
					const result = await runWhisper(videoId);
					return {
						source: "whisper" as const,
						rawText: result.rawText,
						segments: result.segments,
					};
				},
				catch: (error) =>
					new TranscriptionError({
						videoId,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

/**
 * Default Whisper implementation: downloads audio via yt-dlp, preprocesses
 * to 16kHz mono WAV with noise reduction, runs whisper.cpp with medium model.
 *
 * HITL decisions baked in:
 * - Model: medium
 * - VAD: --vad enabled
 * - No-speech threshold: 0.6
 * - Audio: 16kHz mono WAV + highpass=200,lowpass=3000,afftdn
 * - Initial prompt: Ellettsville civic vocabulary
 */
const WHISPER_INITIAL_PROMPT = [
	"Ellettsville",
	"Town Council",
	"Plan Commission",
	"BZA",
	"Board of Zoning Appeals",
	"ordinance",
	"resolution",
	"annexation",
	"Sale Street",
	"Temperance Street",
	"INDOT",
	"TIF district",
	"remonstrance",
].join(", ");

async function defaultRunWhisper(videoId: string): Promise<WhisperResult> {
	const { execSync } = await import("node:child_process");
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const workDir = mkdtempSync(join(tmpdir(), "civic-whisper-"));

	try {
		const audioPath = join(workDir, "audio.wav");
		const outputPath = join(workDir, "output");

		// Download audio with yt-dlp and preprocess with ffmpeg
		// 16kHz mono WAV + noise reduction (highpass, lowpass, afftdn)
		execSync(
			[
				"yt-dlp",
				"--extract-audio",
				"--audio-format",
				"wav",
				"-o",
				join(workDir, "raw.%(ext)s"),
				`https://www.youtube.com/watch?v=${videoId}`,
			].join(" "),
			{ stdio: "pipe" },
		);

		execSync(
			[
				"ffmpeg",
				"-i",
				join(workDir, "raw.wav"),
				"-ar",
				"16000",
				"-ac",
				"1",
				"-af",
				"highpass=f=200,lowpass=f=3000,afftdn",
				audioPath,
			].join(" "),
			{ stdio: "pipe" },
		);

		// Run whisper.cpp with medium model, VAD, and civic vocabulary prompt
		execSync(
			[
				"whisper-cpp",
				"--model",
				"medium",
				"--vad",
				"--no-speech-threshold",
				"0.6",
				"--output-json",
				"--output-file",
				outputPath,
				"--initial-prompt",
				`"${WHISPER_INITIAL_PROMPT}"`,
				audioPath,
			].join(" "),
			{ stdio: "pipe", timeout: 60 * 60 * 1000 }, // 60 min timeout
		);

		const jsonOutput = JSON.parse(readFileSync(`${outputPath}.json`, "utf-8"));
		const segments: TranscriptSegment[] = (jsonOutput.transcription ?? []).map(
			(seg: { text: string; offsets: { from: number; to: number } }) => ({
				text: seg.text.trim(),
				startMs: seg.offsets.from,
				durationMs: seg.offsets.to - seg.offsets.from,
			}),
		);

		const rawText = segments.map((s) => s.text).join(" ");
		return { rawText, segments };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Fallback chain: captions → Whisper
// ---------------------------------------------------------------------------

/**
 * Effect teaching note: This is the key composition pattern — Effect.catchTag.
 * When captions fail with TranscriptionError, we catch that specific tag and
 * try Whisper instead. If Whisper also fails, the TranscriptionError propagates.
 * Callers just see TranscriptionService — they don't know about the fallback.
 */

type TranscriptionServiceLiveConfig = {
	fetchTranscriptFn?: (videoId: string) => Promise<CaptionSegment[]>;
	runWhisperFn?: (videoId: string) => Promise<WhisperResult>;
};

function TranscriptionServiceLive(config: TranscriptionServiceLiveConfig = {}) {
	return Layer.succeed(TranscriptionService, {
		transcribe: (videoId) => {
			// Try captions first
			const captionsAttempt = Effect.tryPromise({
				try: async () => {
					const fetchTranscript =
						config.fetchTranscriptFn ?? defaultFetchTranscript;
					const segments = await fetchTranscript(videoId);
					const rawText = segments.map((s) => s.text).join(" ");
					return {
						source: "captions" as const,
						rawText,
						segments: segments.map((s) => ({
							text: s.text,
							startMs: s.offset,
							durationMs: s.duration,
						})),
					};
				},
				catch: (error) =>
					new TranscriptionError({
						videoId,
						message: error instanceof Error ? error.message : String(error),
					}),
			});

			// Fall back to Whisper on caption failure
			return captionsAttempt.pipe(
				Effect.catchTag("TranscriptionError", () =>
					Effect.tryPromise({
						try: async () => {
							const runWhisper = config.runWhisperFn ?? defaultRunWhisper;
							const result = await runWhisper(videoId);
							return {
								source: "whisper" as const,
								rawText: result.rawText,
								segments: result.segments,
							};
						},
						catch: (error) =>
							new TranscriptionError({
								videoId,
								message: error instanceof Error ? error.message : String(error),
							}),
					}),
				),
			);
		},
	});
}

export {
	TranscriptionService,
	YouTubeCaptionProviderLive,
	WhisperLocalProviderLive,
	TranscriptionServiceLive,
};
export type {
	TranscriptResult,
	TranscriptSegment,
	TranscriptionServiceInterface,
};
