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
	options: FigureSearch = {},
): T[] {
	return decisions.map((decision) => {
		if (figureIsIn(decision.originalAmount, sourceText, options)) {
			return decision;
		}
		return { ...decision, confidence: decision.confidence * 0.4 };
	});
}

/**
 * A written dollar figure: whole dollars in groups of three digits, then
 * cents. The separator before the cents may be a period, a comma, or missing
 * after a comma group, as a caption writes "$244,21510". A number followed by
 * more digits ends where the cents or the group would stop. A dollar sign
 * directly before the number, with at most one space between, is noted.
 */
const FIGURE_PATTERN =
	/(?<dollarSign>\$ ?)?(?<dollars>\d+(?:[.,]\d{3})*)(?:[.,](?<cents>\d{2})|(?<=,\d{3})(?<runOn>\d{2}))?(?!\d)/g;

/**
 * A written number as dollars and cents. Separators in the dollars are
 * dropped, so a period read for a comma ("$258.400.00") is the same figure; a
 * missing cents part is ".00". The cents are kept apart from the dollars so a
 * stray or missing separator cannot change the magnitude.
 */
function figuresIn(
	text: string,
): { dollars: string; cents: string; hasDollarSign: boolean }[] {
	return [...text.matchAll(FIGURE_PATTERN)].map((match) => ({
		dollars: (match.groups?.dollars ?? "").replace(/\D/g, ""),
		cents: match.groups?.cents ?? match.groups?.runOn ?? "00",
		hasDollarSign: match.groups?.dollarSign !== undefined,
	}));
}

/** How strictly a figure must be written to count as found. */
type FigureSearch = {
	/**
	 * Count only an occurrence written with a dollar sign. Documents write
	 * their figures that way, so a bare number with the same digits is some
	 * other number, or what is left of a figure the scan destroyed
	 * ("fpaa-215.10"). Captions often drop the sign, so a transcript is
	 * searched without this.
	 */
	asDollarAmount?: boolean;
};

/** Whether `originalAmount` names a dollar figure, as opposed to "not stated". */
function statesFigure(originalAmount: string): boolean {
	return /\d/.test(originalAmount);
}

/**
 * Whether the first number in `originalAmount` appears in `text` with the same
 * dollars and the same cents. A period read for a comma ("$258.400.00"), a
 * dropped comma and a missing ".00" do not hide a figure that is there; a
 * figure with cents is not found by its dollars alone, and "$750.00" is not
 * found in "$75,000". A figure broken by a space inside its digits is not
 * found. An amount that names no figure is found by its exact wording.
 */
function figureIsIn(
	originalAmount: string,
	text: string,
	options: FigureSearch = {},
): boolean {
	const wanted = figuresIn(originalAmount)[0];
	if (wanted === undefined) return text.includes(originalAmount);
	return figuresIn(text).some(
		(found) =>
			found.dollars === wanted.dollars &&
			found.cents === wanted.cents &&
			(found.hasDollarSign || !options.asDollarAmount),
	);
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
// side is quoted as its source states it. `kind` is the model's reading of
// what the two sources differ on; `droppedDisagreementKinds` acts on it and
// it is not stored.
const sourceDisagreementSchema = z.object({
	topic: z.string(),
	documentsSay: z.string(),
	transcriptSays: z.string(),
	kind: z.enum(["amount", "vote", "date", "name", "other"]),
}) satisfies z.ZodType<SourceDisagreement>;

type ReportedDisagreement = z.infer<typeof sourceDisagreementSchema>;

/**
 * Captions garble names, so a name the transcript spells differently says
 * nothing about the meeting. The documents govern how a name is spelled.
 */
const droppedDisagreementKinds: ReadonlySet<ReportedDisagreement["kind"]> =
	new Set(["name"]);

/**
 * The reported disagreements worth showing a reader, without their kind.
 * The model's label is soft, so each disagreement dropped on it is logged
 * with its topic and both quoted sides, letting an operator check that no
 * real difference was lost.
 */
function keptDisagreements(
	reported: readonly ReportedDisagreement[],
): SourceDisagreement[] {
	return reported
		.filter((disagreement) => {
			if (!droppedDisagreementKinds.has(disagreement.kind)) return true;
			console.warn(
				`[summarize] dropped source disagreement labelled "${disagreement.kind}": ` +
					`topic "${disagreement.topic}", ` +
					`documents say "${disagreement.documentsSay}", ` +
					`transcript says "${disagreement.transcriptSays}"`,
			);
			return false;
		})
		.map(({ topic, documentsSay, transcriptSays }) => ({
			topic,
			documentsSay,
			transcriptSays,
		}));
}

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
	 * Terms the body's meetings use that a resident may not know, one
	 * "TERM — gloss" line each. Read by the writing call only.
	 */
	glossary?: readonly string[];
	/**
	 * Fiscal decisions already taken from the documents among `sources`. The
	 * generator returns only decisions that are not among them. The service
	 * sets this; a caller of `summarize` does not.
	 */
	recordedDecisions?: SummarizationOutput["fiscalDecisions"];
	/**
	 * Decisions taken from the documents whose dollar figure is not in the
	 * documents. For each, the generator returns an entry under the same title
	 * carrying the figure the transcript states. The service sets this too.
	 */
	unreadFigures?: SummarizationOutput["fiscalDecisions"];
	/**
	 * Only the fiscal decisions are wanted from this call; the generator may
	 * skip the work of writing highlights and prose. The service sets this on
	 * the documents-only pass, whose text it discards.
	 */
	ledgerOnly?: boolean;
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

function normalizedText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether two entries name one motion: the same resolution or ordinance
 * number, or the same title. Amounts are not compared, because many distinct
 * motions share "not stated" and one motion can be given two figures.
 */
function isSameMotion(
	a: SummarizationOutput["fiscalDecisions"][number],
	b: SummarizationOutput["fiscalDecisions"][number],
): boolean {
	const ordinance = normalizedText(a.ordinanceNumber ?? "");
	return (
		(ordinance !== "" &&
			ordinance === normalizedText(b.ordinanceNumber ?? "")) ||
		normalizedText(a.title) === normalizedText(b.title)
	);
}

/** What a disagreement entry says the documents hold for a figure that is not in them. */
const UNREADABLE_FIGURE =
	"No readable figure. The summary uses the video's figure.";

/** Words that open or fill many titles and so say nothing about which item it is. */
const GENERIC_TITLE_WORDS: ReadonlySet<string> = new Set([
	"approval",
	"approve",
	"resolution",
	"ordinance",
	"authorizing",
	"authorize",
	"contract",
	"agreement",
	"amount",
]);

/**
 * The words of a topic that name something: four or more letters or digits,
 * not a bare number (a year or an ordinance number recurs across items) and
 * not one of the generic title words.
 */
function topicWords(topic: string): Set<string> {
	return new Set(
		(normalizedText(topic).match(/[a-z0-9]{4,}/g) ?? []).filter(
			(word) => !/^\d+$/.test(word) && !GENERIC_TITLE_WORDS.has(word),
		),
	);
}

/**
 * Whether a reported disagreement is a second entry for an unread figure
 * already recorded: an amount whose transcript side quotes the same dollars and
 * cents and whose topic shares at least two naming words with the recorded
 * entry's topic, the decision's title. Generic title words and bare numbers do
 * not count as naming words, so two unrelated items titled alike are kept. Other kinds are never dropped, and each
 * drop is logged like those of `keptDisagreements`.
 */
function repeatsUnreadFigure(
	reported: ReportedDisagreement,
	unreadableFigures: readonly SourceDisagreement[],
): boolean {
	if (reported.kind !== "amount") return false;
	const reportedWords = topicWords(reported.topic);
	const repeated = unreadableFigures.find(
		(figure) =>
			figureIsIn(figure.transcriptSays, reported.transcriptSays) &&
			[...topicWords(figure.topic)].filter((word) => reportedWords.has(word))
				.length >= 2,
	);
	if (repeated === undefined) return false;
	console.warn(
		`[summarize] dropped source disagreement repeating the unread figure for "${repeated.topic}": ` +
			`topic "${reported.topic}", ` +
			`documents say "${reported.documentsSay}", ` +
			`transcript says "${reported.transcriptSays}"`,
	);
	return true;
}

/**
 * The full result returned by the service — schema output plus the model
 * identifier, which gets persisted alongside the summary for auditing.
 * `sourceDisagreements` is empty unless both kinds of source were passed, and
 * never holds a disagreement over how a name is spelled.
 */
type SummarizationResult = Omit<SummarizationOutput, "sourceDisagreements"> & {
	sourceDisagreements: SourceDisagreement[];
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
									ledgerOnly: true,
								})
							).fiscalDecisions
						: [];
					// The documents govern a figure only when it can be found in them. A
					// figure that cannot was rebuilt by the model from an illegible scan.
					const documentsText = sourceTextOfKind(input.sources, "documents");
					const unread = documentDecisions.filter(
						(decision) =>
							statesFigure(decision.originalAmount) &&
							!figureIsIn(decision.originalAmount, documentsText, {
								asDollarAmount: true,
							}),
					);
					const read = documentDecisions.filter(
						(decision) => !unread.includes(decision),
					);
					const raw = await config.generateFn(
						bothKinds
							? { ...input, recordedDecisions: read, unreadFigures: unread }
							: input,
					);

					// An unread figure gives way to the one the transcript states for
					// the same motion, when the transcript does state it. Otherwise the
					// decision keeps no amount.
					const transcriptText = sourceTextOfKind(input.sources, "transcript");
					const unreadableFigures: SourceDisagreement[] = [];
					const governed = documentDecisions.map((decision) => {
						if (!unread.includes(decision)) return decision;
						const restated = raw.fiscalDecisions.find(
							(candidate) =>
								isSameMotion(candidate, decision) &&
								statesFigure(candidate.originalAmount) &&
								figureIsIn(candidate.originalAmount, transcriptText),
						);
						if (restated === undefined) {
							return { ...decision, amount: 0, originalAmount: "not stated" };
						}
						unreadableFigures.push({
							topic: decision.title,
							documentsSay: UNREADABLE_FIGURE,
							transcriptSays: restated.originalAmount,
						});
						return {
							...decision,
							amount: restated.amount,
							originalAmount: restated.originalAmount,
						};
					});

					// An entry of the every-source call that names a motion the documents
					// already gave is dropped, whatever amount it carries, so the
					// documents' entry is the only one kept.
					const transcriptDecisions = raw.fiscalDecisions.filter(
						(candidate) =>
							!documentDecisions.some((decision) =>
								isSameMotion(candidate, decision),
							),
					);
					const verified = verifyAmounts(
						[...governed, ...transcriptDecisions],
						verificationText(input.sources),
						{ asDollarAmount: hasSourceKind(input.sources, "documents") },
					);
					// A disagreement needs two kinds of source to disagree; one
					// reported from a single kind is the model inventing the other. The
					// unread figures are already recorded above, so an amount
					// disagreement about the same motion whose transcript side quotes the
					// same dollars and cents as one of them is a second entry for it.
					return {
						...raw,
						fiscalDecisions: verified,
						sourceDisagreements: bothKinds
							? [
									...keptDisagreements(
										raw.sourceDisagreements.filter(
											(reported) =>
												!repeatsUnreadFigure(reported, unreadableFigures),
										),
									),
									...unreadableFigures,
								]
							: [],
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
	figureIsIn,
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
