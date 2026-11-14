import { Data, Effect } from "effect";
import type { SummaryPublication, WriteUp } from "#/pipeline/checks/types.ts";
import type { DatabaseError } from "#/pipeline/errors.ts";
import {
	type HeldSummary,
	StorageService,
} from "#/pipeline/services/StorageService.ts";

/**
 * One line of `summaries:held`: the date, the body and session, why it is
 * held, then each failing gate with its evidence. Evidence that spans lines
 * is joined with " / " so a meeting stays one line.
 */
export function formatHeldSummaryLine(held: HeldSummary): string {
	const where =
		held.session === null ? held.bodySlug : `${held.bodySlug}/${held.session}`;
	const fails =
		held.gateFails.length === 0
			? "-"
			: held.gateFails
					.map(
						(fail) =>
							`${fail.id}: ${fail.evidence.replace(/\s*\n\s*/g, " / ")}`,
					)
					.join("  |  ");
	return [held.meetingDate, where, held.heldReason.padEnd(18), fails].join(
		"  ",
	);
}

/** Why `summaries:release` will not go ahead; nothing has been written. */
export class ReleaseRefused extends Data.TaggedError("ReleaseRefused")<{
	readonly message: string;
	/** Lines to print under the message, such as each failed gate. */
	readonly details: readonly string[];
}> {}

/** What `summaries:release` would do, before anything is written. */
export interface ReleasePlan {
	readonly held: HeldSummary;
	/** Null when the held best draft is released as it is. */
	readonly edited: {
		readonly writeUp: WriteUp;
		readonly publication: SummaryPublication;
	} | null;
}

/**
 * Find the held summary of one meeting and decide what releasing it would
 * write. Reads only.
 */
export function planRelease(input: {
	bodySlug: string;
	date: string;
	session: string;
	note: string;
}): Effect.Effect<ReleasePlan, ReleaseRefused | DatabaseError, StorageService> {
	return Effect.gen(function* () {
		if (input.note.trim() === "") {
			return yield* new ReleaseRefused({
				message: "--note is empty. Say why the summary is released.",
				details: [],
			});
		}
		const storage = yield* StorageService;
		const meeting = yield* storage.getMeetingSourceState(input);
		if (meeting === null) {
			return yield* new ReleaseRefused({
				message: `No meeting for ${input.bodySlug} on ${input.date} with session ${JSON.stringify(input.session)}.`,
				details: [],
			});
		}
		const held = (yield* storage.listHeldSummaries()).find(
			(summary) => summary.meetingId === meeting.meetingId,
		);
		if (held === undefined) {
			return yield* new ReleaseRefused({
				message: `The summary of ${input.bodySlug} on ${input.date} is not held; there is nothing to release.`,
				details: [],
			});
		}
		return { held, edited: null };
	});
}

/** The preview `summaries:release` prints. Draft text is never printed. */
export function describeRelease(
	plan: ReleasePlan,
	note: string,
	now: Date,
): string[] {
	const gates = plan.held.gateFails.map((fail) => fail.id).join(", ") || "-";
	return [
		`  held:          ${plan.held.heldReason}; failing gates: ${gates}`,
		"  status:        held -> published",
		`  released_at:   ${now.toISOString()}`,
		`  release_note:  ${JSON.stringify(note)}`,
		plan.edited === null
			? "  text:          the held best draft, as it is"
			: `  text:          the edited draft (${plan.edited.writeUp.highlights.length} highlights, ${plan.edited.writeUp.prose.length} chars of prose), which passes every gate`,
	];
}
