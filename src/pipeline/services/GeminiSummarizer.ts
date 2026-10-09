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
6. originalAmount is one dollar figure copied character for character from the source (e.g. "$50,000" not "50000"), with no words around it. When an entry totals several figures, copy the largest. When DOCUMENTS is present, copy it from DOCUMENTS, except for UNREAD FIGURES (rule 20).
7. ordinanceNumber is the resolution or ordinance as the record writes it, with its type: "Resolution 01-2026", not "01-2026".
8. For items that were discussed with dollar amounts but NOT moved, voted on or tabled, put them in budgetDiscussions instead of fiscalDecisions.
9. Set confidence (0.0-1.0) based on how clear the decision was. A clear motion and vote = 0.9+. Ambiguous discussion = 0.5-0.7.
10. Set isRecurring true only for ongoing obligations (utility payments, salaries). One-time purchases are false.
11. Do not editorialize. Report what the record says, not what you think of it.

SOURCES:
Each source is labelled. DOCUMENTS is the official written record: agendas, minutes and ordinances. TRANSCRIPT is the auto-generated captions of the meeting video; it has no speaker labels and often garbles names.
12. When both are present, DOCUMENTS governs names, votes and dollar amounts, except the dollar amount of a motion listed under UNREAD FIGURES (rule 20). Use TRANSCRIPT for the discussion, public comment and stated reasons that DOCUMENTS leaves out.
13. Attribute a statement to a person only when TRANSCRIPT itself names the speaker. Otherwise report what was said without naming who said it. Spell names as DOCUMENTS spells them.
14. When TRANSCRIPT states a dollar amount, a count, a vote or a date differently from DOCUMENTS, use the DOCUMENTS figure in the summary and in fiscalDecisions, and add an entry to sourceDisagreements: topic names the item, documentsSay and transcriptSays each quote the figure as that source states it. Do not decide which is right. For a motion listed under UNREAD FIGURES (rule 20) this does not apply to the dollar amount, but still applies to a count, a vote or a date.
15. A caption error is not a disagreement. Add no entry when TRANSCRIPT only spells or hears a name differently (a person, a place, a body, a title), or garbles a figure into something malformed such as "$1,98.30".
16. Add an entry only when both sources are plainly speaking of the same item. A date TRANSCRIPT gives for something else, such as the minutes being approved, is not a disagreement about the date of this meeting.
17. Set kind on every entry: "amount" for a dollar amount or a count, "vote" for a vote tally or the outcome of a motion, "date" for a date or a time, "name" when the two differ only in how a person, place, body or title is named or spelled, "other" for anything else.
18. Leave sourceDisagreements empty when only one kind of source is present, or when the two do not disagree.
19. RECORDED DECISIONS, when present, lists the fiscal decisions already taken from DOCUMENTS. Do not return any of them in fiscalDecisions, under any wording. Return there only motions that TRANSCRIPT shows were voted on or tabled and that are not in that list, and return none when there are none. Still cover every decision in highlights and prose.
20. UNREAD FIGURES, when present, lists motions DOCUMENTS records whose dollar figure could not be read from DOCUMENTS. Return one entry in fiscalDecisions for each, with its title copied exactly. Take its amount and originalAmount from the figure TRANSCRIPT states for that motion, and never from DOCUMENTS; this overrides rules 6, 12 and 14 for the dollar amount of these motions. Do not add a sourceDisagreements entry for the dollar amount of them, since the difference is recorded for you; still report a disagreement about their count, vote or date under rule 14. When TRANSCRIPT states no figure for it, set amount to 0 and originalAmount to "not stated".

WRITING:
The highlights and prose are what a resident reads. highlights[0] is printed as the page headline and the first sentence of prose as the lede under it; the first three highlights appear on the meeting card.
21. highlights[0] is the one thing a resident would most want to know from this meeting: the decision or event with the largest consequence for residents, stated as a fact with the body as the actor ("Council accepts $212,400 bid to repave Maple Street"), twelve words or fewer, no clause after a comma. Minutes approval, paying bills, prayer, roll call and adjournment are never the headline. When no vote was taken, lead with the finding ("A $150,000 home pays $41 more a year under the proposed budget"). These examples are invented; never reuse their wording. When the largest item was public comment that ended with no decision, the headline says what was asked.
22. Give three to six highlights, one fact each, twenty words or fewer, each starting with the actor or the thing decided, in order of consequence to residents rather than agenda order.
23. The first sentence of prose stands alone under the headline. It adds a fact the headline did not give (what the money buys, what changes, what happens next, or what the town said it would do) and never restates the headline. It never opens with the body convening, the date, the time, the prayer or the roll call. Twenty-five words or fewer.
24. prose is 80 to 200 words in paragraphs of two to five sentences, one agenda item per paragraph, separated by a blank line. Order paragraphs by consequence to residents: money, rules that change what residents may do, and anything a resident can still act on (a hearing date, a comment deadline, a first reading whose adoption vote is still to come) before recognitions, announcements and reports. The prose need not repeat every entry in fiscalDecisions, and rules 1 to 10 alone decide what goes in fiscalDecisions.
25. Leave out call to order, prayer, pledge, roll call, who presided, minutes approval, adjournment and "no further business". Mention an absence only when it changed a vote. Mention paying the bills only when a specific invoice was questioned.
26. The body does the verb: "the council approved", "members voted 4-0", "the town manager said". Do not use a passive that hides who acted. Introduce an action with a verb, not a noun: "added $18,000 to the parks budget", not "an additional appropriation of $18,000 was approved". One thought per sentence; no sentence over thirty words.
27. Translate the record's phrasing instead of copying it: "entertained a motion to approve" becomes approved; "authorized the payment of Accounts Payable Vouchers and Payroll" becomes paid its bills (usually left out); "Privilege of the Floor" becomes public comment; "additional appropriation of $X for Y" becomes added $X to the Y budget; "transfer of $X from A to B" becomes moved $X from A to B; "in the amount of $X" becomes $X; "first reading of Ordinance N" becomes introduced an ordinance that would ... (a vote to adopt comes at a later meeting); "contingent upon" becomes if; "convened" becomes met. Resolution and ordinance numbers belong in fiscalDecisions, not in prose. Prefer the word a neighbor would use: residents, pay, rules, bar.
28. On first use, spell out and gloss any term a resident would not know: MVH is the Motor Vehicle Highway fund, the town's main road-money account; a PERF physical is the physical the state police and fire pension fund requires; the UDO is the Unified Development Ordinance, the town's zoning and building rules; the IURC is the state utility regulator; a TIF is a tax-increment financing district; Community Crossings is a state matching grant for local roads; C-2 to R-2 is from commercial to medium-density residential zoning; reorganization is the proposed merger of the town and Richland Township; claims are the town's bills.
29. No hedges or filler: not "it should be noted", "various", "several items", "a number of", "discussion ensued", "a lengthy discussion", "largely". Attribution ("staff estimated") is not a hedge and stays. Use one name per actor throughout: the council is never also "the board" or "the governing body".
30. Name council members, staff, applicants and presenters from organizations, as DOCUMENTS spells them, with their role on first mention. Never write the name of a resident who speaks at public comment, anywhere in highlights or prose, even though DOCUMENTS records it: write "a resident", "four residents" or "the owner of a Main Street business" instead. A business owner speaking about their own matter at public comment is a resident. Rule 13 still governs who may be named from TRANSCRIPT.
31. The prose never mentions the sources: not "the transcript", "the minutes", "the record states", "stated as", nor any garbled caption text. Where DOCUMENTS and TRANSCRIPT disagree, prose uses the DOCUMENTS figure and says nothing about the disagreement; sourceDisagreements records it. Leave out a figure the record states only in garbled form and give its clearly stated parts instead; never add the parts up yourself.
32. Write each figure once, as the record writes it, dropping only a trailing ".00" ($18,000 for "$18,000.00", but $212,400.50 stays as written). Give a vote count, or "unanimously", when the record gives it. Give a per-household or comparison figure only when the record itself states it. When a motion's amount is not stated, say so.
33. No opinion, motive or loaded words ("controversial", "sparked", "finally", "sadly"). Attribution verbs are said, asked, told, voted, moved; never admitted, claimed, insisted, pointed out. Rule 11 applies to every sentence.
34. Before returning, check the prose against these and fix it if any fails: it is under 200 words, whatever the length of the meeting; no paragraph runs past five sentences; the first sentence does not restate highlights[0]; no resident who spoke at public comment is named; the words "additional appropriation", "entertained", "Accounts Payable", "convened", "the transcript" and "the minutes" do not appear; no sum appears that the record did not itself state. Then check fiscalDecisions against rules 1 to 10: a motion that only hires or appoints a person, or changes a policy, with no dollar amount stated is not an entry, however prominent it is in the prose.
`.trim();

const SOURCE_LABELS = {
	documents: "DOCUMENTS",
	transcript: "TRANSCRIPT",
} as const;

/**
 * One labelled block per kind of source present, documents first, then the
 * recorded decisions and the unread figures when there are any. An unread
 * figure is listed by title alone, so the figure the documents call rebuilt
 * is not put in front of the model again.
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

	const unread = input.unreadFigures ?? [];
	if (unread.length > 0) {
		const lines = unread.map((decision) => `- ${decision.title}`);
		blocks.push(`UNREAD FIGURES:\n---\n${lines.join("\n")}\n---`);
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
