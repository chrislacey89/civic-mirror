---
date: 2026-10-07
category: patterns
problem_type: an LLM rubric asks for a measurement the production input does not carry
components: [pipeline, drama-detection, ai-boundary, transcription]
technologies: [gemini, ai-sdk, youtube-transcript, vitest]
severity: high
volatility: stable
---

# An LLM rubric that asks for a measurement the input lacks gets an invented one

## Problem

A rubric category asked the model to count minutes from transcript timestamps. The transcript production sends had no timestamps. The model would have answered anyway, and nothing downstream could tell a measured duration from an invented one.

## Context

Issue #155 replaced the process-scoring rubric with v2 (`evals/profiles/v2.ts`). The goal was to score only what a resident could check against the recording, so v2 added `undecided_time`: minutes spent on an item that ended with no vote. The rubric told the model to "use the transcript timestamps", to state the minutes in the narrative, and to write headlines such as "Council spends 25 minutes on X, takes no vote".

Three facts about the existing pipeline made that unanswerable:

- Production wires the captions-only transcript provider (`src/pipeline/composition.ts`).
- That provider joins caption segments into `rawText` and keeps the offsets in a separate `segments` array.
- `formatTranscriptWithTimestamps` returned `rawText` unchanged for captions. Only the Whisper path, which production does not use, inlined `[MM:SS]` markers.

The user prompt already labeled the text "Transcript (with inline timestamps)" under v1. That label was false for captions before this change; v1 never asked for a duration, so it did not matter until v2 did.

## Symptoms

- A rubric or prompt names an input feature ("timestamps", "speaker labels", "page numbers") that the code path feeding it does not produce.
- A test for the LLM boundary passes a hand-written input string instead of one built by the production formatter. Here it was `"[00:00] Call to order."`.
- The only mechanical check on the model's output verifies something else. Here quote verification confirms a quote appears in the transcript, so a real quote attached to an invented minute count passes.

## Root Cause

The rubric was written from what the category needed, and the input was assumed from a function name (`formatTranscriptWithTimestamps`) and a prompt label, not read from what production sends. A language model does not fail on a missing input. It produces a plausible value, so the gap has no error, no empty field and no failing test.

The test that should have caught it used a fixture in the shape the rubric wanted. A fixture written by hand to match the prompt can only confirm the prompt agrees with itself.

## Learning Level

- **Level:** Pattern. It recurs whenever a prompt asks for a quantity that must be read off the input, as opposed to a judgment about it.
- **Feedback loop or delay:** Missing feedback. The model's answer is the same shape whether the input supported it or not, and the first real call under the new rubric would have been a production write.

## Rule Scope

- **Applies when:** a prompt asks the model for a value it must read or compute from a specific feature of the input (a time, a count tied to markers, a speaker, a location in a document), and that feature is added by code on some input paths and not others.
- **Inverts or does not apply when:** the requested value is a judgment over content the input always carries (a category score backed by a verbatim quote). There the quote check is real evidence. It also does not apply when the output field is mechanically derivable from other fields in the same response; that is the neighboring rule in `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md`.
- **Sibling docs:** `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md` (a derived field the model should not be trusted to compute), `placeholder-stubs-in-production-paths-2026-04-10.md` (plausible output with nothing behind it).

## Solution

The formatter now inlines `[MM:SS]` markers for captions from the segment offsets, at most one every 30 seconds. Quote verification strips those markers before matching, so a quote that spans a marker still verifies against the spoken words.

**Before:**
```typescript
if (transcript.source === "captions") {
	return transcript.rawText;
}
```

**After:**
```typescript
if (transcript.source === "captions") {
	return transcript.segments.length > 0
		? stampCaptionSegments(transcript.segments)
		: transcript.rawText;
}
```

The composition test now builds its input from a captions `TranscriptResult` through the formatter and asserts that the prompt the model receives carries the markers.

Two gaps were known when this was written and are not closed by the fix:

- No test exercises the orchestrator's own call to the formatter. Replacing that call with `transcript.rawText` leaves the suite green, because the composition test calls the formatter itself.
- `youtube-transcript` 1.3.1 returns offsets in milliseconds on its primary parsing path and in seconds on its fallback path, and the provider stores both as `startMs`. On the fallback path the markers would be wrong.

## Prevention

**Code-level:**
- For every input feature a prompt names, build the test input with the same function production uses. Do not hand-write a string in the shape the prompt expects.
- Test at the point where the formatted input is consumed (the orchestrator), not only the formatter and the boundary separately.
- When a prompt asks for a measured value, give that value a mechanical check of its own, or do not ask for it. Quote verification does not cover a number.

**Process-level:**
- In `/research` and `/write-a-prd` for any prompt or rubric change: list each input feature the prompt relies on, and for each one cite the line of production code that puts it in the input. A feature with no citation is an open assumption.
- A new rubric's first real call should not be a production write. Detection has no non-storing path today; a dry-run mode for one detection would let a new prompt and schema be tried safely.

## Planning / Calibration Notes

- **What widened the work:** the new category looked like a prompt-only change and turned out to need a formatter change and a change to quote matching.
- **What tightened the work:** an independent review that read the transcript provider instead of the prompt found the gap before anything was scored.
- **Future planning adjustment:** treat "add a rubric category" as an input-contract change as well as a prompt change, and budget for the formatter and the verification path.

## Key Decision

**Decision:** inline time markers for captions instead of dropping the time-based category.
**Rationale:** dropping it would leave six categories and force new tier thresholds; inlining also makes the existing "with inline timestamps" prompt label true.
**Alternatives considered:** drop `undecided_time` and the minutes framing until transcripts carry time.
**Revisable:** yes. If the offset-unit ambiguity or the cost of markers proves a problem, dropping the category is still available while v2 has not scored real meetings.

## Related

- PR: https://github.com/chrislacey89/civic-mirror/pull/160
- Issue: https://github.com/chrislacey89/civic-mirror/issues/155
- Nearest existing entry: `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md`. It is a different pattern: that one concerns a field the model derives from its own response and code can recompute; this one concerns a value the model cannot get from its input at all, which code cannot recompute from the response.

## Shelf Life

Evergreen for as long as a language model answers a question its input cannot support without signaling that it could not.
