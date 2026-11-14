import { createHash } from "node:crypto";
import type { SummarizationInput } from "#/pipeline/services/SummarizationService.ts";
import { hasSourceKind } from "#/pipeline/sources.ts";
import type {
	CheckContext,
	CheckId,
	CheckReport,
	GateId,
	WriteUp,
} from "./types.ts";

/** What the judge reads: the writer's inputs, the officials list and the draft. */
export interface JudgeInput {
	readonly context: CheckContext;
	readonly draft: WriteUp;
}

/**
 * A model judge for the checks code cannot decide. `run` resolves to a
 * report with a verdict for every id in `JUDGE_OWNS`, or to "unavailable";
 * it may also reject, which the caller treats as unavailable.
 */
export interface Judge {
	/** `judgeFingerprint` of the model, prompt and settings this judge runs. */
	readonly fingerprint: string;
	readonly run: (input: JudgeInput) => Promise<CheckReport | "unavailable">;
}

/** The judgment checks the judge decides; the ones #195 calibrated. */
export const JUDGE_OWNS = [
	"A2",
	"A4",
	"A5",
] as const satisfies readonly CheckId[];

/**
 * The checks whose judge verdict may hold a page, by the meeting's sources:
 * those whose calibration record (`calibrate-judge`) clears every bar in
 * `calibration.ts`. Every other judge verdict only flags. A5 is not gated: its
 * corpus fail edits are names the code names check already holds, so the
 * judge's A5 job has not been measured.
 */
export const JUDGE_GATED = {
	documents: ["A2"],
	transcript: [],
} as const satisfies Readonly<
	Record<"documents" | "transcript", readonly GateId[]>
>;

/** Which split of `JUDGE_GATED` a meeting falls in. */
export function splitOf(input: SummarizationInput): keyof typeof JUDGE_GATED {
	return hasSourceKind(input.sources, "documents") ? "documents" : "transcript";
}

/** The checks whose judge verdict may hold this meeting's page. */
export function gatedFor(input: SummarizationInput): readonly GateId[] {
	return JUDGE_GATED[splitOf(input)];
}

/** JSON with object keys sorted, so key order does not change a hash. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * A hash of what decides a judge's verdicts: its model, its fixed prompt and
 * its call settings. A judge whose fingerprint differs from the calibrated
 * one has not been calibrated.
 */
export function judgeFingerprint(cfg: {
	model: string;
	prompt: string;
	settings: Record<string, unknown>;
}): string {
	return createHash("sha256").update(canonical(cfg)).digest("hex").slice(0, 16);
}
