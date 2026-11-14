import { Data, Effect } from "effect";
import {
	checkDraft,
	gateEvidence,
	toPublication,
} from "#/pipeline/checks/prePublish.ts";
import type { SummaryPublication, WriteUp } from "#/pipeline/checks/types.ts";
import type { DatabaseError } from "#/pipeline/errors.ts";
import { officialsFor } from "#/pipeline/officials/index.ts";
import {
	type HeldSummary,
	StorageService,
	type SummaryRoundRow,
} from "#/pipeline/services/StorageService.ts";
import { readableSources } from "#/pipeline/sources.ts";

/**
 * Read an edited draft for `summaries:release --file`: the highlights as a
 * "- " list, a blank line, then the prose. Null when either part is missing.
 */
export function parseReleaseFile(text: string): WriteUp | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && lines[i]?.trim() === "") i++;
	const highlights: string[] = [];
	while (i < lines.length && lines[i]?.startsWith("- ")) {
		const highlight = lines[i]?.slice(2).trim() ?? "";
		if (highlight !== "") highlights.push(highlight);
		i++;
	}
	if (i < lines.length && lines[i]?.trim() !== "") return null;
	const prose = lines.slice(i).join("\n").trim();
	if (highlights.length === 0 || prose === "") return null;
	return { highlights, prose };
}

/**
 * One line of `summaries:held`: the date, the body and session, why it is
 * held, then each failing gate with its evidence. Evidence that spans lines
 * is joined with " / " so a meeting stays one line.
 *
 * Only A5 blanks resident names in its evidence; the other gates quote the
 * draft as written. So when A5 is among the failures, no evidence is printed
 * and the line shows the gate ids alone, so a list never un-redacts a name.
 */
export function formatHeldSummaryLine(held: HeldSummary): string {
	const where =
		held.session === null ? held.bodySlug : `${held.bodySlug}/${held.session}`;
	const namesResident = held.gateFails.some((fail) => fail.id === "A5");
	const fails =
		held.gateFails.length === 0
			? "-"
			: held.gateFails
					.map((fail) =>
						namesResident
							? fail.id
							: `${fail.id}: ${fail.evidence.replace(/\s*\n\s*/g, " / ")}`,
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
	/** The text of a `--file` draft, released in place of the held one. */
	editedText?: string;
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
		if (input.editedText === undefined) return { held, edited: null };

		const writeUp = parseReleaseFile(input.editedText);
		if (writeUp === null) {
			return yield* new ReleaseRefused({
				message:
					'The file is not a draft: write the highlights as a "- " list, a blank line, then the prose.',
				details: [],
			});
		}
		// The same code checks a model draft goes through, against the stored
		// sources and ledger, read only.
		const stored = yield* storage.getStoredWriteUp(meeting.meetingId);
		const sources = yield* storage.getMeetingSources(meeting.meetingId);
		const outcome = checkDraft({
			draft: { ...writeUp, finishReason: null, usage: null },
			context: {
				input: {
					sources: readableSources(sources),
					meetingContext: `${input.bodySlug}, ${input.date}`,
				},
				ledger: stored?.ledger ?? [],
				officials: officialsFor(input.bodySlug, input.date),
			},
		});
		if (outcome.kind === "held") {
			return yield* new ReleaseRefused({
				message: "The edited draft fails a gate; nothing was written.",
				details: gateEvidence(outcome),
			});
		}
		return {
			held,
			edited: {
				writeUp,
				publication: toPublication(outcome, `release-${crypto.randomUUID()}`),
			},
		};
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

/** The window `summaries:held --stats` reports on. */
export const HOLD_STATS_DAYS = 56;

/**
 * The hold rate over the last 8 weeks: of the meetings checked in the
 * window, how many had their latest check run end held, which is every round
 * of that run failing a gate. A run written by `summaries:release --file` is
 * the operator's, not the check's, so it is left out.
 */
export function holdStats(
	rounds: readonly SummaryRoundRow[],
	now: Date,
): { meetings: number; held: number; rate: number } {
	const since = now.getTime() - HOLD_STATS_DAYS * 24 * 60 * 60 * 1000;
	const byMeeting = new Map<number, SummaryRoundRow[]>();
	for (const round of rounds) {
		if (round.runId.startsWith("release-")) continue;
		if (round.createdAt === null || round.createdAt.getTime() < since) continue;
		byMeeting.set(round.meetingId, [
			...(byMeeting.get(round.meetingId) ?? []),
			round,
		]);
	}
	let held = 0;
	for (const meetingRounds of byMeeting.values()) {
		const lastRun = meetingRounds.at(-1)?.runId;
		const run = meetingRounds.filter((round) => round.runId === lastRun);
		if (run.every((round) => round.gateFailures > 0)) held++;
	}
	const meetings = byMeeting.size;
	return { meetings, held, rate: meetings === 0 ? 0 : held / meetings };
}

/** The line `summaries:held --stats` prints. */
export function formatHoldStats(stats: {
	meetings: number;
	held: number;
	rate: number;
}): string {
	return `last ${HOLD_STATS_DAYS / 7} weeks: ${stats.held} of ${stats.meetings} meetings held (${(stats.rate * 100).toFixed(1)}%)`;
}
