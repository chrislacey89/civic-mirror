import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { LlmError } from "#/pipeline/errors.ts";
import type {
	LabelledSource,
	SourceDisagreement,
	SourceKind,
} from "#/pipeline/sources.ts";

/**
 * The minimum shape a fiscal decision must have for amount verification.
 * This is the input contract for {@link verifyAmounts}.
 *
 * The generic constraint `<T extends FiscalDecisionCandidate>` in verifyAmounts
 * means callers can pass objects with additional fields (like `vendor`,
 * `budgetCategory`) and those fields will be preserved in the output — the
 * function only reads the fields it needs.
 */
type FiscalDecisionCandidate = {
	title: string;
	description: string;
	amount: number;
	/** The raw dollar string as extracted by the LLM (e.g. "$50,000"). */
	originalAmount: string;
	/** 0.0–1.0 confidence score, downgraded by verification if the amount can't be found. */
	confidence: number;
};

/**
 * Two-pass verification: checks that each extracted dollar amount actually
 * appears in the source text. If the `originalAmount` string (e.g. `"$50,000"`)
 * is not found in the source, the confidence is reduced by 60% — signaling
 * that the LLM may have hallucinated the amount.
 *
 * This catches the "temporal confusion" pitfall where the LLM confuses
 * historical spending references with new decisions. For example, if the
 * minutes say "last year the council spent $200,000 on roads" and the LLM
 * extracts that as a new fiscal decision, the verification step will flag it
 * because `"$200,000"` may appear but in a historical context. (Future
 * iterations may use sentence-level matching rather than document-level.)
 *
 * The function is generic — it accepts and returns objects with any additional
 * fields beyond FiscalDecisionCandidate, only modifying `confidence`.
 *
 * @param decisions - LLM-extracted fiscal decisions to verify.
 * @param sourceText - The text the amounts must appear in; see {@link verificationText}.
 * @returns The same array with confidence scores adjusted for unverified amounts.
 */
function verifyAmounts<T extends FiscalDecisionCandidate>(
	decisions: T[],
	sourceText: string,
): T[] {
	return decisions.map((decision) => {
		const found = sourceText.includes(decision.originalAmount);
		if (found) return decision;
		return { ...decision, confidence: decision.confidence * 0.4 };
	});
}

/**
 * Zod schema for the structured output the LLM must produce.
 *
 * Effect teaching note: Keeping the schema colocated with the service keeps
 * the "what the LLM returns" contract in one place. The orchestrator never
 * deals with raw LLM responses — it only sees `SummarizationResult`, which is
 * the schema-validated, two-pass-verified shape produced by `summarize`.
 *
 * The fields mirror the `MeetingInput` shape that `StorageService.storeMeeting`
 * expects, so the orchestrator can pipe summarizer output directly into the
 * storage call without additional transformation.
 */
const fiscalDecisionSchema = z.object({
	title: z.string(),
	description: z.string(),
	amount: z.number(),
	originalAmount: z.string(),
	budgetCategory: z.string().optional(),
	status: z.enum(["approved", "denied", "tabled"]),
	voteRecord: z
		.object({
			yea: z.number(),
			nay: z.number(),
			abstain: z.number(),
		})
		.optional(),
	vendor: z.string().optional(),
	fundingSource: z.string().optional(),
	ordinanceNumber: z.string().optional(),
	confidence: z.number().min(0).max(1),
	isRecurring: z.boolean(),
});

const budgetDiscussionSchema = z.object({
	topic: z.string(),
	estimatedAmount: z.number().optional(),
	notes: z.string().optional(),
});

// Strings only: Gemini's structured output rejects numeric enums, and each
// side is quoted as its source states it.
const sourceDisagreementSchema = z.object({
	topic: z.string(),
	documentsSay: z.string(),
	transcriptSays: z.string(),
}) satisfies z.ZodType<SourceDisagreement>;

const summarizationOutputSchema = z.object({
	highlights: z.array(z.string()),
	prose: z.string(),
	fiscalDecisions: z.array(fiscalDecisionSchema),
	budgetDiscussions: z.array(budgetDiscussionSchema),
	sourceDisagreements: z.array(sourceDisagreementSchema),
});

type SummarizationOutput = z.infer<typeof summarizationOutputSchema>;

type SummarizationInput = {
	/** Every source to summarize together. Several may share a kind. */
	sources: LabelledSource[];
	/** Short context line for the prompt (e.g. "Town Council, March 23, 2026"). */
	meetingContext: string;
	/**
	 * Fiscal decisions already taken from the documents among `sources`. The
	 * generator returns only decisions that are not among them. The service
	 * sets this; a caller of `summarize` does not.
	 */
	recordedDecisions?: SummarizationOutput["fiscalDecisions"];
};

/** The texts of the sources of one kind, joined. Empty when there is none. */
function sourceTextOfKind(
	sources: readonly LabelledSource[],
	kind: SourceKind,
): string {
	return sources
		.filter((source) => source.kind === kind)
		.map((source) => source.text)
		.join("\n\n");
}

function hasSourceKind(
	sources: readonly LabelledSource[],
	kind: SourceKind,
): boolean {
	return sources.some((source) => source.kind === kind);
}

/**
 * The text extracted amounts are verified against. Documents are the official
 * record of a figure, so a transcript is consulted only when there are none:
 * captions that repeat a figure differently must not vouch for it.
 */
function verificationText(sources: readonly LabelledSource[]): string {
	return hasSourceKind(sources, "documents")
		? sourceTextOfKind(sources, "documents")
		: sourceTextOfKind(sources, "transcript");
}

/**
 * The full result returned by the service — schema output plus the model
 * identifier, which gets persisted alongside the summary for auditing.
 * `sourceDisagreements` is empty unless both kinds of source were passed.
 */
type SummarizationResult = SummarizationOutput & {
	model: string;
};

interface SummarizationServiceInterface {
	summarize(
		input: SummarizationInput,
	): Effect.Effect<SummarizationResult, LlmError>;
}

class SummarizationService extends Context.Service<
	SummarizationService,
	SummarizationServiceInterface
>()("SummarizationService") {}

/**
 * Injectable generator function — this is the boundary between the Effect
 * world and the Vercel AI SDK world. In production, `createGeminiGenerator`
 * (or a Kimi equivalent) returns one of these. In tests, callers pass a stub
 * that returns a canned `SummarizationOutput`, skipping the real HTTP call.
 */
type SummarizationGenerateFn = (
	input: SummarizationInput,
) => Promise<SummarizationOutput>;

type SummarizationServiceConfig = {
	/** Model identifier recorded alongside each summary (e.g. "gemini-2.5-flash"). */
	model: string;
	/** Async generator that produces a structured summary from source text. */
	generateFn: SummarizationGenerateFn;
};

/**
 * Effect teaching note: This service follows the same dependency-injection
 * pattern as the other scrapers — an async function (`generateFn`) is passed
 * in via config, and the Effect layer wraps it in `Effect.tryPromise` so
 * thrown exceptions become typed `LlmError` values.
 *
 * After the LLM call returns, `verifyAmounts` runs as the second pass of the
 * two-pass extraction: any fiscal decision whose `originalAmount` string
 * doesn't appear in the verification text gets its confidence reduced, protecting
 * against the "temporal confusion" hallucination pitfall (confusing historical
 * spending references with new decisions).
 */
function SummarizationServiceLive(
	config: SummarizationServiceConfig,
): Layer.Layer<SummarizationService> {
	return Layer.succeed(SummarizationService, {
		summarize: (input) =>
			Effect.tryPromise({
				try: async () => {
					const bothKinds =
						hasSourceKind(input.sources, "documents") &&
						hasSourceKind(input.sources, "transcript");
					// Documents govern fiscal decisions, so theirs are taken from the
					// documents alone and kept as extracted: a transcript can add a
					// decision but cannot remove or alter one.
					const documentDecisions = bothKinds
						? (
								await config.generateFn({
									sources: input.sources.filter(
										(source) => source.kind === "documents",
									),
									meetingContext: input.meetingContext,
								})
							).fiscalDecisions
						: [];
					const raw = await config.generateFn(
						bothKinds
							? { ...input, recordedDecisions: documentDecisions }
							: input,
					);
					const verified = verifyAmounts(
						[...documentDecisions, ...raw.fiscalDecisions],
						verificationText(input.sources),
					);
					// A disagreement needs two kinds of source to disagree; one
					// reported from a single kind is the model inventing the other.
					return {
						...raw,
						fiscalDecisions: verified,
						sourceDisagreements: bothKinds ? raw.sourceDisagreements : [],
						model: config.model,
					};
				},
				catch: (error) =>
					new LlmError({
						model: config.model,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

export {
	SummarizationService,
	SummarizationServiceLive,
	sourceTextOfKind,
	verifyAmounts,
	summarizationOutputSchema,
};
export type {
	FiscalDecisionCandidate,
	LabelledSource,
	SummarizationGenerateFn,
	SummarizationInput,
	SummarizationOutput,
	SummarizationResult,
	SummarizationServiceConfig,
};
