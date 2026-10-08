import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import type {
	SummarizationGenerateFn,
	SummarizationInput,
	SummarizationOutput,
} from "./SummarizationService.ts";
import {
	sourceTextOfKind,
	summarizationOutputSchema,
} from "./SummarizationService.ts";

/**
 * Effect teaching note: This file is the boundary between the Effect world
 * and the Vercel AI SDK. It's deliberately kept out of SummarizationService.ts
 * so that the service module has no transitive dependency on @ai-sdk/google
 * at import time — tests can import SummarizationService without pulling in
 * the AI SDK and paying its module-load cost.
 *
 * `createGeminiSummarizer` returns a plain async function that matches the
 * `SummarizationGenerateFn` contract. The orchestrator injects this into
 * `SummarizationServiceLive` in production; tests inject a stub instead.
 */

type GeminiSummarizerConfig = {
	/** Gemini model ID (e.g. "gemini-2.5-flash"). */
	modelId: string;
};

const SYSTEM_INSTRUCTIONS = `
You are a civic journalism assistant summarizing local government meeting records for a public transparency website.

Your job is to extract a factual, neutral summary of what happened in the meeting, plus structured fiscal decisions where money was discussed or voted on.

FISCAL DECISIONS:
1. fiscalDecisions holds exactly one entry for every motion the body voted on or tabled that spends, receives, transfers, appropriates or commits money, or that approves a contract, agreement, grant, bond, bid, purchase or claim. Go through the record item by item and leave none out. Do not include historical spending references or "we spent X last year" mentions.
2. Include such a motion even when the record states no dollar amount for it: set amount to 0 and originalAmount to "not stated". Never fill in an amount by estimating, and never multiply or annualize one: a "$750 per month" retainer has amount 750. A motion that only hires or appoints a person, declares property surplus or changes a policy, with no dollar amount stated, is not a fiscal decision.
3. A tabled or denied motion is still an entry, with that status.
4. One motion is one entry. A resolution or ordinance that carries several amounts is one entry whose amount is their total; describe the parts in description. Do not split it into several entries.
5. A motion to pay claims, accounts payable vouchers or payroll is one entry, with amount 0 when the record gives no total. When a specific invoice or claim is named with its dollar amount while that motion is considered (for example a member asks what an $8,000 invoice was for), add a second entry for that invoice, with its amount and the motion's status.
6. originalAmount is one dollar figure copied character for character from the source (e.g. "$50,000" not "50000"), with no words around it. When an entry totals several figures, copy the largest. When DOCUMENTS is present, copy it from DOCUMENTS.
7. ordinanceNumber is the resolution or ordinance as the record writes it, with its type: "Resolution 01-2026", not "01-2026".
8. For items that were discussed with dollar amounts but NOT moved, voted on or tabled, put them in budgetDiscussions instead of fiscalDecisions.
9. Set confidence (0.0-1.0) based on how clear the decision was. A clear motion and vote = 0.9+. Ambiguous discussion = 0.5-0.7.
10. Set isRecurring true only for ongoing obligations (utility payments, salaries). One-time purchases are false.
11. Do not editorialize. Report what the record says, not what you think of it.

SOURCES:
Each source is labelled. DOCUMENTS is the official written record: agendas, minutes and ordinances. TRANSCRIPT is the auto-generated captions of the meeting video; it has no speaker labels and often garbles names.
12. When both are present, DOCUMENTS governs names, votes and dollar amounts. Use TRANSCRIPT for the discussion, public comment and stated reasons that DOCUMENTS leaves out.
13. Attribute a statement to a person only when TRANSCRIPT itself names the speaker. Otherwise report what was said without naming who said it. Spell names as DOCUMENTS spells them.
14. When TRANSCRIPT states a dollar amount, a count, a vote or a date differently from DOCUMENTS, use the DOCUMENTS figure in the summary and in fiscalDecisions, and add an entry to sourceDisagreements: topic names the item, documentsSay and transcriptSays each quote the figure as that source states it. Do not decide which is right.
15. A caption error is not a disagreement. Add no entry when TRANSCRIPT only spells or hears a name differently (a person, a place, a body, a title), or garbles a figure into something malformed such as "$1,98.30".
16. Add an entry only when both sources are plainly speaking of the same item. A date TRANSCRIPT gives for something else, such as the minutes being approved, is not a disagreement about the date of this meeting.
17. Set kind on every entry: "amount" for a dollar amount or a count, "vote" for a vote tally or the outcome of a motion, "date" for a date or a time, "name" when the two differ only in how a person, place, body or title is named or spelled, "other" for anything else.
18. Leave sourceDisagreements empty when only one kind of source is present, or when the two do not disagree.
19. RECORDED DECISIONS, when present, lists the fiscal decisions already taken from DOCUMENTS. Do not return any of them in fiscalDecisions, under any wording. Return there only motions that TRANSCRIPT shows were voted on or tabled and that are not in that list, and return none when there are none. Still cover every decision in highlights and prose.
`.trim();

const SOURCE_LABELS = {
	documents: "DOCUMENTS",
	transcript: "TRANSCRIPT",
} as const;

/**
 * One labelled block per kind of source present, documents first, then the
 * recorded decisions when there are any.
 */
function buildSummarizationPrompt(input: SummarizationInput): string {
	const blocks = (["documents", "transcript"] as const)
		.filter((kind) => input.sources.some((source) => source.kind === kind))
		.map(
			(kind) =>
				`${SOURCE_LABELS[kind]}:\n---\n${sourceTextOfKind(input.sources, kind)}\n---`,
		);

	const recorded = input.recordedDecisions ?? [];
	if (recorded.length > 0) {
		const lines = recorded.map(
			(decision) =>
				`- ${decision.title} (${decision.originalAmount}, ${decision.status})`,
		);
		blocks.push(`RECORDED DECISIONS:\n---\n${lines.join("\n")}\n---`);
	}

	return `
Meeting context: ${input.meetingContext}

${blocks.join("\n\n")}

Produce a structured summary of this meeting.
`.trim();
}

/**
 * Builds a SummarizationGenerateFn backed by Gemini via @ai-sdk/google.
 *
 * The Google provider reads GOOGLE_GENERATIVE_AI_API_KEY from the environment
 * automatically, so no API key is passed here. Callers construct this in the
 * CLI entry point where env config is loaded via dotenv, and pass the result
 * into SummarizationServiceLive.
 */
function createGeminiSummarizer(
	config: GeminiSummarizerConfig,
): SummarizationGenerateFn {
	return async (input: SummarizationInput): Promise<SummarizationOutput> => {
		const { experimental_output } = await generateText({
			model: google(config.modelId),
			system: SYSTEM_INSTRUCTIONS,
			// The fiscal list is a record, so the same sources should give the
			// same list on every run.
			temperature: 0,
			prompt: buildSummarizationPrompt(input),
			experimental_output: Output.object({
				schema: summarizationOutputSchema,
			}),
		});
		return experimental_output;
	};
}

export { buildSummarizationPrompt, createGeminiSummarizer };
export type { GeminiSummarizerConfig };
