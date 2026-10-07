import { Context, Effect, Layer } from "effect";
import { TranscriptionError } from "#/pipeline/errors.ts";

/**
 * Effect teaching note: This module demonstrates the "multiple implementations
 * behind one Tag" pattern. TranscriptionService is a single Context.Service with
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

class TranscriptionService extends Context.Service<
	TranscriptionService,
	TranscriptionServiceInterface
>()("TranscriptionService") {}

// ---------------------------------------------------------------------------
// YouTubeCaptionProvider
// ---------------------------------------------------------------------------

type CaptionSegment = { text: string; duration: number; offset: number };

type CaptionFetchConfig = {
	fetchTranscriptFn?: (videoId: string) => Promise<CaptionSegment[]>;
	confirmCaptionsDisabledFn?: (videoId: string) => Promise<boolean>;
};

type YouTubeCaptionProviderConfig = CaptionFetchConfig;

/**
 * The caption fetch reported that the video has no caption tracks. This is a
 * claim, not proof: youtube-transcript says the same for unavailable videos
 * and for pages YouTube served differently to a blocked client, so callers
 * confirm it against the watch page before treating captions as disabled.
 */
class CaptionTracksMissingError extends Error {
	constructor(videoId: string) {
		super(`No caption tracks reported for video ${videoId}`);
		this.name = "CaptionTracksMissingError";
	}
}

/**
 * youtube-transcript returns [] rather than throwing when YouTube serves a
 * response it can't parse, so empty captions must be rejected here. Otherwise
 * they'd be stored as a real transcript (and, in the chain, skip the Whisper
 * fallback).
 */
function assertCaptionText(segments: CaptionSegment[]) {
	if (segments.every((s) => s.text.trim().length === 0)) {
		throw new Error("Captions came back empty");
	}
}

/**
 * Extracts the JSON object assigned to `var ytInitialPlayerResponse` in a
 * watch page. Brace matching skips braces inside string literals, since video
 * titles and descriptions can contain them. Returns null when the assignment
 * is missing or the JSON doesn't parse.
 */
function parsePlayerResponse(html: string): unknown {
	const startToken = "var ytInitialPlayerResponse = ";
	const startIndex = html.indexOf(startToken);
	if (startIndex === -1) return null;
	const jsonStart = startIndex + startToken.length;

	let depth = 0;
	let inString = false;
	for (let i = jsonStart; i < html.length; i++) {
		const char = html[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(html.slice(jsonStart, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * True only when the watch page positively shows a playable video with no
 * caption tracks: status OK, the requested video's own details, and streaming
 * data. youtube-transcript reports "disabled" for any page without caption
 * tracks, including unavailable videos and pages YouTube served differently to
 * a blocked client, so every other shape (missing or unparseable player
 * response, another status, a different video, tracks present) is false and
 * stays retryable.
 */
function readCaptionsDisabled(watchPageHtml: string, videoId: string): boolean {
	const player = parsePlayerResponse(watchPageHtml);
	if (!isRecord(player)) return false;

	const { playabilityStatus, videoDetails, streamingData, captions } = player;
	if (!isRecord(playabilityStatus) || playabilityStatus.status !== "OK") {
		return false;
	}
	if (!isRecord(videoDetails) || videoDetails.videoId !== videoId) {
		return false;
	}
	if (!isRecord(streamingData)) return false;

	const renderer = isRecord(captions)
		? captions.playerCaptionsTracklistRenderer
		: undefined;
	const tracks = isRecord(renderer) ? renderer.captionTracks : undefined;
	return !(Array.isArray(tracks) && tracks.length > 0);
}

/**
 * Effect teaching note: The fetchTranscriptFn injection follows the same
 * pattern as YouTubeScraper's fetchFn — accept a function parameter so tests
 * can substitute a mock, while production uses the real youtube-transcript call.
 */
function YouTubeCaptionProviderLive(config: YouTubeCaptionProviderConfig = {}) {
	return Layer.succeed(TranscriptionService, {
		transcribe: (videoId) => captionsAttempt(config, videoId),
	});
}

/**
 * Fetches captions and shapes them into a TranscriptResult. Shared by the
 * caption provider and the captions-then-Whisper chain so both classify
 * failures the same way. Only a "no caption tracks" report that the watch page
 * confirms sets captionsDisabled; every other failure, including a
 * confirmation that fails or disagrees, is an ordinary retryable error.
 */
function captionsAttempt(
	config: CaptionFetchConfig,
	videoId: string,
): Effect.Effect<TranscriptResult, TranscriptionError> {
	const fetchTranscript = config.fetchTranscriptFn ?? defaultFetchTranscript;
	const confirmCaptionsDisabled =
		config.confirmCaptionsDisabledFn ?? defaultConfirmCaptionsDisabled;

	/**
	 * Resolves a "no caption tracks" report into a classified error. The watch
	 * page check is best effort: if it throws, the report stays unconfirmed.
	 */
	const classifyMissingTracks = async (
		error: CaptionTracksMissingError,
	): Promise<TranscriptionError> => {
		const confirmed = await confirmCaptionsDisabled(videoId).catch(() => false);
		return confirmed
			? new TranscriptionError({
					videoId,
					message: "Captions are disabled for this video",
					captionsDisabled: true,
				})
			: new TranscriptionError({
					videoId,
					message: `${error.message} (captions disabled not confirmed)`,
				});
	};

	return Effect.tryPromise({
		try: async () => {
			let segments: CaptionSegment[];
			try {
				segments = await fetchTranscript(videoId);
			} catch (error) {
				if (error instanceof CaptionTracksMissingError) {
					throw await classifyMissingTracks(error);
				}
				throw error;
			}
			assertCaptionText(segments);
			const rawText = segments.map((s) => s.text).join(" ");
			const unitMs = captionUnitMs(segments);
			return {
				source: "captions" as const,
				rawText,
				segments: segments.map((s) => ({
					text: s.text,
					startMs: Math.round(s.offset * unitMs),
					durationMs: Math.round(s.duration * unitMs),
				})),
			};
		},
		catch: (error) =>
			error instanceof TranscriptionError
				? error
				: new TranscriptionError({ videoId, message: errorMessage(error) }),
	});
}

/**
 * youtube-transcript returns integer milliseconds from its srv3 branch and
 * float seconds from its classic branch, with nothing on the segments to say
 * which. A fractional offset or duration can only come from the classic
 * branch, so it means the whole transcript is in seconds. A classic transcript
 * whose values are all integers is indistinguishable from srv3 and stays as is.
 */
function captionUnitMs(segments: CaptionSegment[]): number {
	const hasFraction = segments.some(
		(s) => !Number.isInteger(s.offset) || !Number.isInteger(s.duration),
	);
	return hasFraction ? 1000 : 1;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function defaultFetchTranscript(
	videoId: string,
): Promise<CaptionSegment[]> {
	const { YoutubeTranscript, YoutubeTranscriptDisabledError } = await import(
		"youtube-transcript"
	);
	try {
		return await YoutubeTranscript.fetchTranscript(videoId);
	} catch (error) {
		if (error instanceof YoutubeTranscriptDisabledError) {
			throw new CaptionTracksMissingError(videoId);
		}
		throw error;
	}
}

/**
 * Loads the watch page the way a desktop browser would and checks whether it
 * positively shows a playable video without caption tracks. Network failures
 * and non-2xx responses throw, which the caller treats as unconfirmed.
 */
async function defaultConfirmCaptionsDisabled(
	videoId: string,
): Promise<boolean> {
	const response = await fetch(
		`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
		{
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Accept-Language": "en",
			},
		},
	);
	if (!response.ok) {
		throw new Error(`Watch page request failed with ${response.status}`);
	}
	return readCaptionsDisabled(await response.text(), videoId);
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
	const { execFileSync } = await import("node:child_process");
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const workDir = mkdtempSync(join(tmpdir(), "civic-whisper-"));

	try {
		const audioPath = join(workDir, "audio.wav");
		const outputPath = join(workDir, "output");

		// Download audio with yt-dlp and preprocess with ffmpeg
		// 16kHz mono WAV + noise reduction (highpass, lowpass, afftdn).
		// execFileSync bypasses /bin/sh, so the yt-dlp `%(ext)s` template token
		// and any tmpdir paths containing spaces survive without quoting.
		execFileSync(
			"yt-dlp",
			[
				"--extract-audio",
				"--audio-format",
				"wav",
				"-o",
				join(workDir, "raw.%(ext)s"),
				`https://www.youtube.com/watch?v=${videoId}`,
			],
			{ stdio: "pipe" },
		);

		execFileSync(
			"ffmpeg",
			[
				"-i",
				join(workDir, "raw.wav"),
				"-ar",
				"16000",
				"-ac",
				"1",
				"-af",
				"highpass=f=200,lowpass=f=3000,afftdn",
				audioPath,
			],
			{ stdio: "pipe" },
		);

		// Run whisper.cpp with medium model, VAD, and civic vocabulary prompt
		execFileSync(
			"whisper-cpp",
			[
				"--model",
				"medium",
				"--vad",
				"--no-speech-threshold",
				"0.6",
				"--output-json",
				"--output-file",
				outputPath,
				"--initial-prompt",
				WHISPER_INITIAL_PROMPT,
				audioPath,
			],
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

type TranscriptionServiceLiveConfig = CaptionFetchConfig & {
	runWhisperFn?: (videoId: string) => Promise<WhisperResult>;
};

function TranscriptionServiceLive(config: TranscriptionServiceLiveConfig = {}) {
	return Layer.succeed(TranscriptionService, {
		transcribe: (videoId) =>
			// Try captions first, fall back to Whisper on any caption failure
			captionsAttempt(config, videoId).pipe(
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
								message: errorMessage(error),
							}),
					}),
				),
			),
	});
}

export {
	CaptionTracksMissingError,
	readCaptionsDisabled,
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
