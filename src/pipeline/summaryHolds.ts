import type { HeldSummary } from "#/pipeline/services/StorageService.ts";

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
