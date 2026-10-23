import type {
	SummarizationInput,
	SummarizationOutput,
} from "#/pipeline/services/SummarizationService.ts";

/** A check whose failure holds the summary. Each is defined in docs/writing-rubric.md. */
export type GateId = "A1" | "A2" | "A3" | "A4" | "A5" | "TRUNC";

/** A check whose failure only flags the summary. Each is defined in docs/writing-rubric.md. */
export type StyleId =
	| "B1"
	| "B2"
	| "B3"
	| "B4"
	| "C1"
	| "C2"
	| "C3"
	| "C4"
	| "D1"
	| "D2"
	| "D3"
	| "D4"
	| "D5"
	| "D6"
	| "E1"
	| "E2"
	| "E3"
	| "E4"
	| "F1"
	| "F2"
	| "F3"
	| "F4"
	| "G1"
	| "G2"
	| "G3"
	| "G4";

export type CheckId = GateId | StyleId;

export const GATE_IDS = [
	"A1",
	"A2",
	"A3",
	"A4",
	"A5",
	"TRUNC",
] as const satisfies readonly GateId[];

export const STYLE_IDS = [
	"B1",
	"B2",
	"B3",
	"B4",
	"C1",
	"C2",
	"C3",
	"C4",
	"D1",
	"D2",
	"D3",
	"D4",
	"D5",
	"D6",
	"E1",
	"E2",
	"E3",
	"E4",
	"F1",
	"F2",
	"F3",
	"F4",
	"G1",
	"G2",
	"G3",
	"G4",
] as const satisfies readonly StyleId[];

export const CHECK_IDS: readonly CheckId[] = [...GATE_IDS, ...STYLE_IDS];

/** `unchecked` counts as a failure for a gate. */
export type Verdict =
	| { readonly outcome: "pass" }
	/** Quoted draft text, and what the source says when a source was read. */
	| { readonly outcome: "fail"; readonly evidence: string }
	| { readonly outcome: "unchecked"; readonly reason: string };

export interface CheckReport {
	/** Every id the checker owns is present. */
	readonly verdicts: Readonly<Partial<Record<CheckId, Verdict>>>;
}

/** What the writing call is told about one failed check when it revises. */
export interface Feedback {
	readonly checkId: CheckId;
	/** The offending draft text, verbatim. */
	readonly quote: string;
	/** What the check found in the sources; never replacement wording. */
	readonly finding: string;
}

export interface WriteUp {
	readonly highlights: readonly string[];
	readonly prose: string;
}

export interface TokenUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly reasoningTokens: number | null;
}

/** A write-up as the writing call returned it, with what the call reported. */
export type WrittenDraft = WriteUp & {
	readonly finishReason: string | null;
	readonly usage: TokenUsage | null;
};

export interface Round {
	readonly round: number;
	readonly draft: WrittenDraft;
	readonly code: CheckReport;
	readonly judge: CheckReport | "unavailable" | "skipped";
	readonly gateFailures: number;
	/** 0–26. */
	readonly styleScore: number;
	readonly groundedFigures: number;
}

export type PrePublishOutcome =
	| {
			readonly kind: "publish";
			readonly best: WriteUp;
			readonly rounds: readonly Round[];
	  }
	| {
			readonly kind: "publish-flagged";
			readonly best: WriteUp;
			readonly styleFails: readonly StyleId[];
			readonly rounds: readonly Round[];
	  }
	| {
			readonly kind: "held";
			readonly reason: SummaryHeldReason;
			readonly best: WriteUp;
			readonly gateFails: readonly GateId[];
			readonly rounds: readonly Round[];
	  };

export interface CheckContext {
	readonly input: SummarizationInput;
	readonly ledger: SummarizationOutput["fiscalDecisions"];
}

export interface CodeCheck {
	/** Every id listed here must receive a verdict from `run`. */
	readonly owns: readonly CheckId[];
	readonly run: (
		draft: WriteUp,
		ctx: CheckContext,
	) => Partial<Record<CheckId, Verdict>>;
}

export type SummaryHeldReason = "gate-failed" | "critic-unavailable";

/** What a summary's storage needs to know about the check it went through. */
export interface SummaryPublication {
	readonly status: "published" | "held";
	readonly heldReason: SummaryHeldReason | null;
	/** One check run, shared by all of its rounds. */
	readonly runId: string;
	readonly rounds: readonly Round[];
}
