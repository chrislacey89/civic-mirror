import type { TranscriptResult } from "./TranscriptionService";

export function formatTranscriptWithTimestamps(
	transcript: TranscriptResult,
): string {
	if (transcript.source === "captions") {
		return transcript.rawText;
	}

	if (
		transcript.source === "whisper" &&
		transcript.segments &&
		transcript.segments.length > 0
	) {
		return reconstructWithTimestamps(transcript.rawText, transcript.segments);
	}

	return transcript.rawText;
}

function reconstructWithTimestamps(
	rawText: string,
	segments: Array<{ text: string; startMs: number; durationMs: number }>,
): string {
	let result = "";
	const words = rawText.split(/\s+/);

	for (let i = 0; i < words.length; i++) {
		const word = words[i];

		let matchedSegment = false;
		for (const segment of segments) {
			const segmentWords = segment.text.split(/\s+/);
			let matches = true;

			for (let j = 0; j < segmentWords.length && i + j < words.length; j++) {
				if (words[i + j].toLowerCase() !== segmentWords[j].toLowerCase()) {
					matches = false;
					break;
				}
			}

			if (matches) {
				const timestamp = formatTimestamp(segment.startMs);
				result += `[${timestamp}] `;

				for (let j = 0; j < segmentWords.length; j++) {
					result += words[i + j];
					if (j < segmentWords.length - 1) {
						result += " ";
					}
				}

				i += segmentWords.length - 1;
				matchedSegment = true;
				break;
			}
		}

		if (!matchedSegment) {
			result += word;
		}

		if (i < words.length - 1) {
			result += " ";
		}
	}

	return result;
}

function formatTimestamp(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
