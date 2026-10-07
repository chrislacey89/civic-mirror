import type { MatchHoldReason } from "#/pipeline/services/MeetingMatchService.ts";
import type { HeldVideo } from "#/pipeline/services/StorageService.ts";

/**
 * Why a video is held: a permanent outcome for a playlist entry the pipeline
 * cannot use. A held video is never attached or transcribed automatically.
 */
export type HeldReason =
	| MatchHoldReason // see MatchHoldReason for the two reasons a match is held
	| "near-date" // no meeting on the title date; one PDF-only meeting within two days
	| "unrecognized-title" // title does not start with the body's name, or has no long-form date
	| "no-captions"; // captions disabled on the video

/**
 * One line of `held:list`. The title comes last because it is the only field
 * of unbounded width; `-` stands for a value the hold does not carry.
 */
export function formatHeldVideoLine(
	held: Pick<
		HeldVideo,
		| "videoId"
		| "title"
		| "meetingDate"
		| "reason"
		| "probability"
		| "sharedIdentifiers"
	>,
): string {
	const probability =
		held.probability === undefined ? "-" : held.probability.toFixed(2);
	return [
		held.videoId.padEnd(11),
		(held.meetingDate ?? "-").padEnd(10),
		held.reason.padEnd(18),
		`p=${probability}`.padEnd(6),
		`shared=${held.sharedIdentifiers ?? "-"}`,
		held.title,
	].join("  ");
}
