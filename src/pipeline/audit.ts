import { Effect } from "effect";
import { runCodeChecks } from "#/pipeline/checks/index.ts";
import {
	type RedactedEvidence,
	redactedEvidence,
} from "#/pipeline/checks/prePublish.ts";
import type { CheckId, Verdict } from "#/pipeline/checks/types.ts";
import type { DatabaseError } from "#/pipeline/errors.ts";
import { officialsFor } from "#/pipeline/officials/index.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { readableSources } from "#/pipeline/sources.ts";

/**
 * One verdict short of a pass on one stored summary. `evidence` is what may
 * be printed: it went through `redactedEvidence` with the rest of that
 * meeting's non-passes, so a quote is withheld when A5 fails there.
 */
type AuditFinding = {
	date: string;
	checkId: CheckId;
	evidence: RedactedEvidence;
};

/**
 * Runs the registered code checks over every summary a body has stored, held
 * or published, and returns each verdict that is not a pass, oldest meeting
 * first. Reads only: nothing is written, so a check can be measured against
 * the published summaries before it is enforced.
 */
function auditSummaries(input: {
	bodySlug: string;
	/** Only this check's verdicts. */
	checkId?: CheckId;
}): Effect.Effect<AuditFinding[], DatabaseError, StorageService> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const meetings = yield* storage.listSummaryMeetings({
			bodySlug: input.bodySlug,
			scope: "all",
		});

		const findings: AuditFinding[] = [];
		for (const meeting of meetings) {
			const stored = yield* storage.getStoredWriteUp(meeting.meetingId);
			if (stored === null) continue;
			const sources = yield* storage.getMeetingSources(meeting.meetingId);
			const report = runCodeChecks(stored.writeUp, {
				input: {
					sources: readableSources(sources),
					meetingContext: `${input.bodySlug}, ${meeting.date}`,
				},
				ledger: stored.ledger,
				officials: officialsFor(input.bodySlug, meeting.date),
			});
			const nonPasses = (
				Object.entries(report.verdicts) as [CheckId, Verdict][]
			).flatMap(([checkId, verdict]) =>
				verdict.outcome === "pass" ? [] : [{ checkId, verdict }],
			);
			const evidence = redactedEvidence(
				nonPasses.map(({ checkId, verdict }) => ({
					id: checkId,
					evidence:
						verdict.outcome === "fail"
							? verdict.evidence
							: `unchecked: ${verdict.reason}`,
					quotesDraft: verdict.outcome === "fail",
					judged: false,
				})),
			);
			nonPasses.forEach(({ checkId }, i) => {
				if (input.checkId !== undefined && checkId !== input.checkId) return;
				findings.push({
					date: meeting.date,
					checkId,
					evidence: evidence[i] as RedactedEvidence,
				});
			});
		}
		return findings;
	});
}

/** One line of `summaries:audit`: the date, the check id, and the evidence. */
function formatAuditLine(finding: AuditFinding): string {
	return [finding.date, finding.checkId.padEnd(5), finding.evidence].join("  ");
}

export { auditSummaries, formatAuditLine };
export type { AuditFinding };
