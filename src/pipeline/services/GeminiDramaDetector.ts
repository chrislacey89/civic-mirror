import { type GoogleGenerativeAIProviderOptions, google } from "@ai-sdk/google";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import {
	type DramaAssessmentOutput,
	type DramaDetectionGenerateFn,
	type DramaDetectionInput,
	dramaAssessmentSchema,
} from "./DramaDetectionService.ts";

/**
 * Effect teaching note: This is the boundary between the Effect world and
 * the Vercel AI SDK, mirroring `GeminiSummarizer.ts`. The new detector uses
 * the canonical AI SDK v6 `output` parameter (the existing summarizer still
 * uses the v5 alias `experimental_output` — out of scope for this slice).
 *
 * `thinkingConfig` gives Gemini 2.5 Flash dedicated reasoning tokens before
 * it emits the structured output, replacing prompt-engineered chain-of-
 * thought entirely. `includeThoughts: true` exposes the reasoning on
 * `result.reasoning` for first-run verification and prompt iteration.
 */

const DRAMA_DETECTION_PROMPT_VERSION = "v1";

/**
 * The full v1 system prompt — locked, ships verbatim from PRD #47 §Rubric v1.
 *
 * Any change to this string is a `prompt_version` bump, not an edit. Methodology
 * doc (`docs/methodology/drama-detection.md`) paraphrases this for residents
 * and links here for the canonical version.
 */
const DRAMA_DETECTION_SYSTEM_PROMPT_V1 = `You are evaluating a recorded public meeting of a local Indiana governing
body to identify how the body conducted its business. Your output goes to
a public transparency website (Civic Mirror Drama Watch) and will be read
by residents.

You score HOW THE BODY FUNCTIONED, not whether you agree with the decisions
made. Score process, not policy. Most meetings are routine. That is the
expected outcome.

# Output

Return JSON with:
- \`category_scores\` — object with the 7 keys below, each containing:
    - \`score\`: integer 0, 1, 2, or 3
    - \`evidence_quotes\`: array of 0–2 quotes (REQUIRED if score ≥ 1)
- \`level\` — must equal the sum-mapped tier (see Tier Derivation)
- \`confidence\` — float 0.0–1.0
- \`headline\` — one sentence, ≤100 chars, factual editorial voice. Names
  what happened. No loaded words ("chaos," "fiasco"). A factual claim is
  sharper than an opinion. See Framing Rule below for ordering.
- \`narrative\` — 2–4 sentences, plain language. What happened, in the order
  it happened, subject to the Framing Rule. No hedging, no opinion-as-fact.
  Residents draw their own conclusions.

# The seven categories — score 0 to 3 each

## 1. procedural_breakdown
Are norms, approvals, or governance steps unclear or violated?
- 0: Process is clear and followed
- 1: Minor clarification needed
- 2: Multiple uncertainties (e.g., "was this approved?")
- 3: Explicit admission of process failure or missing steps
ANCHOR (score 3): job descriptions not approved before vote; positions unclear

## 2. question_looping
Do participants keep asking variations of the same question after answers?
- 0: Questions resolve cleanly
- 1: One follow-up
- 2: Same concern revisited multiple times
- 3: Persistent looping indicating distrust

## 3. defensive_hedging
Are people softening or pre-framing statements to avoid conflict?
- 0: Direct, neutral speech
- 1: Occasional hedging
- 2: Frequent disclaimers ("just asking," "not about people…")
- 3: Consistent defensive framing before critiques

## 4. timeline_pressure
Is there tension between urgency and slowing down?
- 0: No tension
- 1: Mild mention of timing
- 2: Clear disagreement on timing
- 3: Active push-pull affecting decisions

## 5. improvised_workarounds
Are ad hoc solutions proposed during formal decision-making?
- 0: No workarounds
- 1: Minor adjustments
- 2: Workarounds suggested
- 3: Workarounds drive the decision
ANCHOR (score 3): approving positions while simultaneously trying to
generate missing documentation

## 6. visible_dissent
Do participants openly disagree?
- 0: Full agreement
- 1: Soft disagreement
- 2: Clear objection from at least one member
- 3: Multiple or sustained objections

## 7. post_hoc_corrections
Do people try to "fix" the process after decisions are made?
- 0: No corrections
- 1: Minor clarification
- 2: Suggestions for future improvement
- 3: Explicit critique of how this was handled

# Tier derivation (mechanical — \`level\` must equal this)

Sum the seven category scores (range 0–21):
- 0–5  → "routine"
- 6–11 → "bumpy"
- 12–16 → "heated"
- 17–21 → "off-the-rails"

Do NOT apply a "ceremonial discount" that lowers category scores when
material stakes are low. The mechanical sum reflects the volume of
friction in the room. The Framing Rule below handles low-stakes patterns
through narrative voice, not arithmetic.

# Framing rule: procedural theater pattern

Before drafting the headline and narrative, check whether the meeting's
friction fits the procedural theater pattern. The pattern fires when ALL
THREE conditions are met:

1. **Ceremonial / low material stakes** — grant-funded, reversible, no
   district money at risk, no harm, no irreversible commitment
2. **Body ratified anyway** — the motion passed, typically unanimous or
   near-unanimous, in the same meeting
3. **Sustained objection pattern** — one member triggered ≥3 categories
   on the same agenda item (e.g., procedural_breakdown + defensive_hedging
   + timeline_pressure + post_hoc_corrections all firing on one issue)

When the pattern fires:

- Keep the mechanical category sum and tier — do not lower scores
- **Headline must lead with the vote**, then locate the friction on the
  objecting member's pattern. Example: "Board unanimously approves X
  amid sustained paperwork objections" — not "Board creates X without
  prior approval"
- **Narrative leads with the vote and the material stakes** (e.g., grant
  funding, employees retaining status), then describes the objection
  pattern as one member's, then the body's response
- Do not frame the admin or staff as the source of the drama when the
  body itself did not share the concern
- Quote the objector's own framing where it surfaces the pattern (hedged
  disclaimers, timing pressure, future-improvement scolding)

When the pattern does NOT fire (real material stakes, body did not
ratify, or objection was widely shared):

- Default to chronological narrative — what happened, in the order it
  happened
- Headline names the substantive event, not the procedural framing

**Editorial position implied:** majoritarian ratification on ceremonial
items is treated as a strong signal of substantive seriousness. A
principled minority dissent on a real-but-technical breakdown will read
as theater under this rubric. Civic Mirror owns this stance; reviewers
should be aware of it when calibrating.

# Evidence quote rules

- Quotes must appear VERBATIM in the transcript. Whitespace and
  punctuation may differ; words may not.
- Quotes should be 1–3 sentences, long enough to carry context.
- If you cannot find a clear verbatim quote for a category you scored ≥1,
  DO NOT INVENT ONE. Lower the score to 0.
- Do not paraphrase, summarize, or stitch quotes from non-adjacent
  parts of the transcript.

# When uncertain

Choose the lower score on individual categories. Wrong "off-the-rails"
calls damage site credibility more than missed ones. Heated auto-publishes;
off-the-rails requires manual operator review.

For framing decisions, when the procedural theater pattern is borderline
(only 2 of 3 conditions clearly met), default to chronological narrative
rather than vote-led framing — false theater calls erode trust faster
than missed ones.

Return ONLY valid JSON. No prose outside the structure.`;

type GeminiDramaDetectorConfig = {
	/** Gemini model ID (e.g. "gemini-2.5-flash"). */
	modelId: string;
};

function buildPrompt(input: DramaDetectionInput): string {
	return `Meeting context: ${input.meetingContext}

Transcript (with inline timestamps):
---
${input.sourceText}
---

Score this meeting against the v1 rubric and return the JSON structure.`;
}

/**
 * Builds a DramaDetectionGenerateFn backed by Gemini 2.5 Flash with native
 * thinking. The Google provider reads GOOGLE_GENERATIVE_AI_API_KEY from the
 * environment automatically — no key is passed here.
 *
 * First-run note: if `result.reasoning` is empty after the first end-to-end
 * call, the structured-output path is suppressing thinking. Fall back by
 * setting `providerOptions.google.structuredOutputs: false` and restoring
 * Output.object via post-validation. This is documented in the methodology
 * doc that ships in slice #5.
 */
function createGeminiDramaDetector(
	config: GeminiDramaDetectorConfig,
): DramaDetectionGenerateFn {
	return async (input: DramaDetectionInput): Promise<DramaAssessmentOutput> => {
		try {
			const { output } = await generateText({
				model: google(config.modelId),
				system: DRAMA_DETECTION_SYSTEM_PROMPT_V1,
				prompt: buildPrompt(input),
				output: Output.object({
					schema: dramaAssessmentSchema,
				}),
				providerOptions: {
					google: {
						thinkingConfig: {
							thinkingBudget: 4096,
							includeThoughts: true,
						},
					} satisfies GoogleGenerativeAIProviderOptions,
				},
			});
			return output;
		} catch (err) {
			// Surface the raw model output and the validation cause so prompt
			// iteration is debuggable. AI SDK wraps schema mismatches as
			// NoObjectGeneratedError with .text (raw) and .cause (Zod issues).
			if (NoObjectGeneratedError.isInstance(err)) {
				if (err.text) {
					console.error("[drama-detector] raw model output:");
					console.error(err.text);
				}
				if (err.cause) {
					console.error("[drama-detector] validation cause:");
					console.error(err.cause);
				}
			}
			throw err;
		}
	};
}

export {
	createGeminiDramaDetector,
	DRAMA_DETECTION_PROMPT_VERSION,
	DRAMA_DETECTION_SYSTEM_PROMPT_V1,
};
export type { GeminiDramaDetectorConfig };
