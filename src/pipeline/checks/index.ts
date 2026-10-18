import { truncationCheck } from "./truncation.ts";
import type {
	CheckContext,
	CheckId,
	CheckReport,
	CodeCheck,
	Verdict,
	WriteUp,
} from "./types.ts";

/** Every code check a draft goes through. */
export const CODE_CHECKS: readonly CodeCheck[] = [truncationCheck];

/**
 * One verdict from several checks that own the same id: fail if any fails,
 * with every failure's evidence; else unchecked if any is unchecked; else
 * pass.
 */
function mergeVerdicts(verdicts: readonly Verdict[]): Verdict {
	const failures = verdicts.flatMap((verdict) =>
		verdict.outcome === "fail" ? [verdict.evidence] : [],
	);
	if (failures.length > 0) {
		return { outcome: "fail", evidence: failures.join("\n") };
	}
	const unchecked = verdicts.find((verdict) => verdict.outcome === "unchecked");
	return unchecked ?? { outcome: "pass" };
}

/**
 * The verdicts of `checks` on a draft. Every id a check owns gets a verdict:
 * one it left out is unchecked, and a verdict for an id it does not own is
 * dropped.
 */
export function runCodeChecks(
	draft: WriteUp,
	ctx: CheckContext,
	checks: readonly CodeCheck[] = CODE_CHECKS,
): CheckReport {
	const byId = new Map<CheckId, Verdict[]>();
	for (const check of checks) {
		const returned = check.run(draft, ctx);
		for (const id of check.owns) {
			const verdict = returned[id] ?? {
				outcome: "unchecked",
				reason: "no verdict",
			};
			byId.set(id, [...(byId.get(id) ?? []), verdict]);
		}
	}
	return {
		verdicts: Object.fromEntries(
			[...byId].map(([id, verdicts]) => [id, mergeVerdicts(verdicts)]),
		),
	};
}
