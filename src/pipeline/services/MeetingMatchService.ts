import { Context, Effect, Layer } from "effect";
import { MeetingMatchError } from "#/pipeline/errors.ts";

/** The parts of a summary the same-meeting check reads. */
type MatchableSummary = {
	highlights: string[];
	prose: string;
	fiscalDecisions: {
		title: string;
		originalAmount: string;
		ordinanceNumber?: string;
	}[];
};

type MatchResult = {
	outcome: "match" | "hold";
	/** Present only when `outcome` is "hold". */
	reason?: "check-failed" | "signals-disagree";
	/** The decision function's probability that both summaries are one meeting. */
	probability: number;
	/** Ordinance/resolution numbers and dollar amounts found in both summaries. */
	sharedIdentifiers: number;
};

/**
 * The boundary a vendor swap happens at. `a` is the transcript summary text,
 * `b` the documents summary text. The return carries a probability and no
 * verdict: the outcome is computed here, never read from the model.
 */
type MatchDecideFn = (input: {
	question: string;
	a: string;
	b: string;
}) => Promise<{ probabilitySameMeeting: number }>;

type MeetingMatchInput = {
	transcriptSummary: MatchableSummary;
	documentsSummary: MatchableSummary;
};

interface MeetingMatchServiceInterface {
	check(
		input: MeetingMatchInput,
	): Effect.Effect<MatchResult, MeetingMatchError>;
}

class MeetingMatchService extends Context.Service<
	MeetingMatchService,
	MeetingMatchServiceInterface
>()("MeetingMatchService") {}

type MeetingMatchServiceConfig = {
	/** Async function that returns the probability two texts are one meeting. */
	decideFn: MatchDecideFn;
};

const SAME_MEETING_QUESTION =
	"Summary A was written from automatic captions of a video of a town council meeting. Summary B was written from scanned official minutes of a town council meeting. Do most of the specific items of business in A also appear in B? Items of business are ordinances, resolutions, bids, appointments, annexations and votes. Ignore spelling differences in names and small differences in dollar figures, because captions and scans contain errors. Ignore routine items every meeting has: approving minutes, paying claims, payroll.";

const MATCH_PROBABILITY_THRESHOLD = 0.5;

const ORDINANCE_NUMBER =
	/\b(?:ordinance|resolution)\s+(?:no\.?\s*)?(\d{1,4}-\d{1,4})\b/gi;
const BARE_ORDINANCE_NUMBER = /\b\d{1,4}-\d{1,4}\b/g;
const DOLLAR_AMOUNT =
	/\$\s?[\d,]+(?:\.\d+)?(?:\s*(million|billion|thousand)\b|(-?[a-z]|\s+(?:hundred|millions|mil|mm|bn|trillion)\b))?/gi;

/**
 * The ordinance/resolution numbers and dollar amounts a summary mentions,
 * normalized so that spacing, case, "No." and thousands separators do not
 * make one identifier look like two. A magnitude word stays part of the
 * amount ("$2 million" is not "$2"), an amount with a magnitude this cannot
 * read ("$2M", "$50K", "$2 mil", "$2-million") is dropped rather than read as
 * the bare number, and a zero amount is a placeholder, not an identifier. Ordinances and resolutions share one
 * numbering namespace here; captions do not reliably say which a number is.
 */
function extractIdentifiers(summary: MatchableSummary): Set<string> {
	const text = [
		...summary.highlights,
		summary.prose,
		...summary.fiscalDecisions.map((decision) => decision.originalAmount),
	].join(" ");

	const numbers = [
		...[...text.matchAll(ORDINANCE_NUMBER)].map((match) => match[1]),
		...summary.fiscalDecisions.flatMap(
			(decision) =>
				decision.ordinanceNumber?.match(BARE_ORDINANCE_NUMBER) ?? [],
		),
	].map((number) => `no:${number}`);

	const amounts = [...text.matchAll(DOLLAR_AMOUNT)]
		.filter((match) => match[2] === undefined)
		.map((match) => {
			const digits = match[0].match(/[\d,]+(?:\.\d+)?/)?.[0] ?? "";
			const magnitude = match[0].match(/[a-z]+$/i)?.[0].toLowerCase();
			return {
				value: Number(digits.replace(/,/g, "")),
				key: `$${digits.replace(/,/g, "").replace(/\.00$/, "")}${magnitude ? ` ${magnitude}` : ""}`,
			};
		})
		.filter(({ value }) => value !== 0)
		.map(({ key }) => key);

	return new Set([...numbers, ...amounts]);
}

function countShared(a: Set<string>, b: Set<string>): number {
	return [...a].filter((identifier) => b.has(identifier)).length;
}

const MONTH_NAMES =
	"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WRITTEN_DATE = new RegExp(
	`\\b(${MONTH_NAMES})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+\\d{4})?|\\d{4}\\b)`,
	"gi",
);
const NUMERIC_DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;

/**
 * Replaces dates with a placeholder. The caller compares meeting dates; the
 * model must judge the items of business and never match on a date.
 */
function stripDates(text: string): string {
	return text
		.replace(WRITTEN_DATE, (date, month: string) =>
			// Lowercase "may" followed by a number is the verb, not the month.
			month === "may" ? date : "[date]",
		)
		.replace(NUMERIC_DATE, "[date]");
}

/** The summary as the text the decision function reads. */
function renderSummary(summary: MatchableSummary): string {
	const moneyDecisions = summary.fiscalDecisions
		.map((decision) => `${decision.title} (${decision.originalAmount})`)
		.join("; ");
	return stripDates(
		[
			"Highlights:",
			...summary.highlights.map((highlight) => `- ${highlight}`),
			"",
			summary.prose,
			"",
			`Money decisions: ${moneyDecisions || "none"}`,
		].join("\n"),
	);
}

/**
 * The decision table from PRD #127. Both signals must agree before a video
 * is combined with documents; the two ways of disagreeing share one reason.
 */
function decide(
	probability: number,
	sharedIdentifiers: number,
): Pick<MatchResult, "outcome" | "reason"> {
	const modelSaysSame = probability >= MATCH_PROBABILITY_THRESHOLD;
	const sharesIdentifier = sharedIdentifiers >= 1;
	if (modelSaysSame && sharesIdentifier) return { outcome: "match" };
	if (!modelSaysSame && !sharesIdentifier) {
		return { outcome: "hold", reason: "check-failed" };
	}
	return { outcome: "hold", reason: "signals-disagree" };
}

/**
 * Effect teaching note: same shape as `SummarizationServiceLive` — the model
 * call is an injected async function, so this file never imports the AI SDK
 * and the tests run on stubs.
 */
function MeetingMatchServiceLive(
	config: MeetingMatchServiceConfig,
): Layer.Layer<MeetingMatchService> {
	return Layer.succeed(MeetingMatchService, {
		check: (input) =>
			Effect.tryPromise({
				try: async () => {
					const sharedIdentifiers = countShared(
						extractIdentifiers(input.transcriptSummary),
						extractIdentifiers(input.documentsSummary),
					);
					const { probabilitySameMeeting: probability } = await config.decideFn(
						{
							question: SAME_MEETING_QUESTION,
							a: renderSummary(input.transcriptSummary),
							b: renderSummary(input.documentsSummary),
						},
					);
					// A percentage or a NaN would otherwise be read as a verdict.
					if (!(probability >= 0 && probability <= 1)) {
						throw new Error(
							`Decision function returned probability ${probability}; expected a number from 0 to 1.`,
						);
					}
					return {
						...decide(probability, sharedIdentifiers),
						probability,
						sharedIdentifiers,
					};
				},
				catch: (error) =>
					new MeetingMatchError({
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

export { MeetingMatchService, MeetingMatchServiceLive, SAME_MEETING_QUESTION };
export type {
	MatchableSummary,
	MatchDecideFn,
	MatchResult,
	MeetingMatchInput,
	MeetingMatchServiceConfig,
};
