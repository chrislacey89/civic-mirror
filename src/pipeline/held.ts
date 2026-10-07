/**
 * Why a video is held: a permanent outcome for a playlist entry the pipeline
 * cannot use. A held video is never attached or transcribed automatically.
 */
export type HeldReason =
	| "check-failed" // model says no, no shared identifiers
	| "signals-disagree" // model and shared identifiers disagree
	| "near-date" // no meeting on the title date; one PDF-only meeting within two days
	| "unrecognized-title" // title does not start with the body's name, or has no long-form date
	| "no-captions"; // captions disabled on the video
