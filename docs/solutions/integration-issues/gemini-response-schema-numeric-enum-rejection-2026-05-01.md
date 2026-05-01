---
date: 2026-05-01
category: integration-issues
problem_type: provider rejects valid JSON Schema feature
components: [pipeline, ai-boundary, drama-detection, summarization]
technologies: [gemini, ai-sdk, zod, vercel-ai-sdk]
severity: high
volatility: volatile
---

# Gemini `response_schema` rejects numeric enums

## Problem

Gemini's structured-output API (the schema you pass via `output: Output.object({ schema })` in AI SDK v6, which becomes `generation_config.response_schema` on the wire) accepts a strictly narrower subset of JSON Schema than full JSON Schema spec. Numeric enums — `enum: [0, 1, 2, 3]` — are rejected even though they validate cleanly under Zod and Output.object accepts them locally. This means a Zod schema that uses `z.union([z.literal(0), ...])` for a small integer field will compile, typecheck, run unit tests with stubbed `generateFn`, and only fail when the real Gemini call is made — with an opaque error pointing at deep schema paths.

## Symptoms

- `LlmError` from the AI SDK's google provider with messages of the form:
  ```
  Invalid value at 'generation_config.response_schema.properties[0].value.properties[0].value.properties[0].value.any_of[0].enum[0]' (TYPE_STRING), 0
  ```
- The path traverses `properties[i].value.properties[j].value.…any_of[k].enum[0]` — Gemini is saying "the value at this position should be a string, but you sent the number 0."
- `(TYPE_STRING), 0` / `(TYPE_STRING), 1` / `(TYPE_STRING), 2` / `(TYPE_STRING), 3` — one error per literal in the rejected union.
- Failure happens at the network boundary; unit tests with stubbed `generateFn` pass because they bypass the schema-to-Gemini translation entirely.

## Root Cause

Gemini's `response_schema` is based on the OpenAPI 3.0 schema subset, not full JSON Schema. The OpenAPI 3.0 `enum` field is type-constrained to its declared `type:` — a `type: "string"` field's enum entries must be strings. A field declared with `any_of: [{ const: 0 }, { const: 1 }, …]` resolves to a numeric enum after Zod 4 → JSON Schema translation, which Gemini's validator interprets as "string-typed enum slot, got a number" and rejects per literal.

Zod's `z.union` of `z.literal` values is the idiomatic way to express "one of these specific values," and the Vercel AI SDK's `Output.object` faithfully translates that into JSON Schema. Neither layer warns that Gemini will reject the result.

## Learning Level

- **Level:** Pattern. Will recur on any field where the natural Zod expression is a small enumerated set of non-string primitives — bool literals, numeric IDs, etc.
- **Feedback loop or delay:** Delayed effect. Local validation, AI SDK type-checks, and stubbed unit tests all pass; only the real-API call fails. The first signal arrives when an operator runs the live pipeline, not when the developer writes the schema.

## Rule Scope

- **Applies when:** Building a Zod schema that will be sent to Gemini via `Output.object({ schema })` (AI SDK v6) or any path that becomes `generation_config.response_schema` on the wire.
- **Inverts or does not apply when:** The schema field is sent through a JSON-mode-only path (`providerOptions.google.structuredOutputs: false`) — Gemini then validates more loosely after generation, and the literal union survives. Also does not apply to OpenAI / Anthropic structured-output paths, which accept full JSON Schema.
- **Sibling docs:** None yet. Adjacent pattern: `docs/solutions/patterns/llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md` (the load-bearing field this pattern protects is also the one most likely to drift across re-runs).

## Solution

Replace literal-union score schemas with constrained number types. The runtime validation behavior is identical for valid values; the JSON Schema translation drops the `enum`/`anyOf` and emits `{ type: "integer", minimum: 0, maximum: 3 }` which Gemini accepts. The tradeoff is the inferred TypeScript type widens from `0|1|2|3` to `number`.

**Before:**

```typescript
const categoryScoreSchema = z.object({
  // Gemini rejects: enum[0..3] under any_of becomes a string-typed enum slot
  score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  evidence_quotes: z.array(z.string()).max(2),
});
```

**After:**

```typescript
const categoryScoreSchema = z.object({
  // Gemini accepts integer with min/max; runtime validation identical for 0–3,
  // and the system prompt instructs the model on the 0–3 anchor scale.
  score: z.number().int().min(0).max(3),
  evidence_quotes: z.array(z.string()).max(2),
});
```

If the literal union is load-bearing for downstream type narrowing, narrow at the boundary (`as 0 | 1 | 2 | 3` after schema validation) rather than expressing it in the schema itself.

## Prevention

**Code-level:**

- For any new field sent to Gemini via `response_schema`, prefer `z.number().int().min().max()` or `z.string()` over `z.union(z.literal(...))` of non-string primitives.
- For string enums (`z.enum(["routine", "bumpy", "heated", "off-the-rails"])`), this issue does not apply — Gemini accepts string enums.
- When the contract genuinely needs a literal-typed TS surface, narrow downstream of `safeParse`, not in the schema definition itself.

**Process-level:**

- Add to `/research`'s Phase 1 verification ladder: when a feature uses a new structured-output schema with Gemini, run the live API call once during the research spike — not at slice-2 verification time. The failure path is opaque and burns a debug round-trip; surfacing it in `/research` lets the PRD pin the schema shape upfront.
- Add to `/write-a-prd`'s "Don't Hand-Roll" scan: "If the structured-output schema uses small integer enums, prefer `int().min/max`."

## Planning / Calibration Notes

- **What widened the work:** Discovered at slice-2 first-run-verification time. Fix was 2 minutes; the round trip (write logging, re-run, parse error path, find the right Zod construct) was ~30 minutes of slice-2 wall-clock plus one wasted Gemini call.
- **What tightened the work:** The PRD's research artifact noted "thinkingConfig + Output.object interaction unverified — verify on first run." That's adjacent to the actual failure mode but didn't predict it; future research scans should explicitly probe schema-to-Gemini translation for any non-string enum field.
- **Future planning adjustment:** When `/research` Phase 1 covers structured-output schemas, the verification step should be "send one real call with the proposed schema," not "confirm Output.object exists in the SDK."

## Defect Classification

- **Origin phase:** Specification error. The PRD locked the schema shape (literal union 0|1|2|3) without verifying it against Gemini's stricter subset. The error did not exist when the PRD was written; it exists because no live-API verification stage was scheduled before slice 2.
- **Fix type:** Correction. The schema now uses a Gemini-compatible representation that preserves the runtime invariant.

## Key Decision

**Decision:** Use `z.number().int().min(0).max(3)` for category scores instead of `z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])`.

**Rationale:** Identical runtime validation for valid values; Gemini-compatible JSON Schema translation; the system prompt already enforces the 0–3 anchor semantics so the LLM contract is unchanged.

**Alternatives considered:**

- Cast to `0 | 1 | 2 | 3` post-parse to preserve narrow downstream typing — rejected as scope creep; `number` propagates fine through the existing storage and orchestrator code.
- Switch to `providerOptions.google.structuredOutputs: false` (JSON mode) — rejected; we want strict validation, and JSON mode loses the schema-enforcement entirely.

**Revisable:** Yes, if Gemini's `response_schema` validator is updated to accept full JSON Schema (specifically OpenAPI 3.1+'s relaxed enum typing), or if we move to a different provider whose structured-output mode accepts numeric enums.

## Related

- PR: https://github.com/chrislacey89/civic-mirror/pull/65
- AI SDK v6: `node_modules/ai/dist/index.d.ts:1468` (canonical `output:` parameter); `node_modules/@ai-sdk/google/dist/*.d.ts:17–19` (`thinkingConfig` shape)
- Gemini API docs: https://ai.google.dev/gemini-api/docs/structured-output
- Adjacent: `docs/solutions/patterns/llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md`

## Shelf Life

When Gemini's `response_schema` validator accepts numeric enums (i.e., adopts OpenAPI 3.1+ enum semantics or relaxes the OpenAPI 3.0 type-coupling), this entire constraint disappears and the literal-union form becomes valid. Until then, stable.
