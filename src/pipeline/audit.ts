import { Effect } from "effect";
import { runCodeChecks } from "#/pipeline/checks/index.ts";
import type { CheckId, Verdict } from "#/pipeline/checks/types.ts";
import type { DatabaseError } from "#/pipeline/errors.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";
import { readableSources } from "#/pipeline/sources.ts";

/** One verdict short of a pass on one stored summary. */
type AuditFinding = {
	date: string;
	checkId: CheckId;
	verdict: Exclude<Verdict, { outcome: "pass" }>;
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
			});
			for (const [checkId, verdict] of Object.entries(report.verdicts) as [
				CheckId,
				Verdict,
			][]) {
				if (verdict.outcome === "pass") continue;
				if (input.checkId !== undefined && checkId !== input.checkId) continue;
				findings.push({ date: meeting.date, checkId, verdict });
			}
		}
		return findings;
	});
}

/** One line of `summaries:audit`: the date, the check id, and the evidence. */
function formatAuditLine(finding: AuditFinding): string {
	const detail =
		finding.verdict.outcome === "fail"
			? finding.verdict.evidence
			: `unchecked: ${finding.verdict.reason}`;
	return [finding.date, finding.checkId.padEnd(5), detail].join("  ");
}

export { auditSummaries, formatAuditLine };
export type { AuditFinding };
