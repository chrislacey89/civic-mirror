---
date: 2026-11-27
category: patterns
problem_type: an in-memory value saved to a file and read back is not the value that was saved
components: [pipeline, rewrite, recheck-preview, pre-publish, schema, storage]
technologies: [typescript, zod, drizzle, sqlite, effect]
severity: high
volatility: stable
paths: [src/pipeline/recheckPreview.ts, src/pipeline/rewrite.ts, src/pipeline/checks/prePublish.ts, src/db/schema.ts]
replaces: []
related: [db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md, empty-output-silent-degradation-2026-04-11.md]
---

# A saved outcome must round-trip exactly, or the confirm stores something nobody previewed

## Problem

`summaries:recheck --confirm` used to call the model a second time and store a draft nobody had read (issue #243). PR #245 fixed it by saving the preview's `PrePublishOutcome` to `.context/recheck-<runId>.json` and storing that file on `--confirm --from`. Writing the value to JSON and reading it back looked like the whole job. It wasn't: in four separate ways, the value read back differed from the value saved, and each difference would have let production store something other than what the operator previewed.

## Context

The preview file exists so that what the operator reads is what production gets (PRD #193 user story 5). That only holds if decode returns the same outcome encode was given. Every way the two can differ is a way back to the original bug.

## Symptoms

- A held outcome read back from its file printed `A1: no verdict` instead of its gate evidence. Nothing failed; the output just got vaguer.
- A field added to `PrePublishOutcome` but not to the zod schema would vanish from the file with no error, and the confirm would store rounds missing it.
- A file whose `kind` was edited from `held` to `publish` would publish a draft the check held.
- Applying the same file twice would store its rounds twice, under the same run id.

## Root Cause

Each symptom has its own cause.

1. **Object identity does not survive serialization.** `gateEvidence` (`src/pipeline/checks/prePublish.ts`) finds the round a best draft came from with `rounds.find((r) => r.draft === outcome.best)`. In memory, `best` *is* one of the rounds' drafts: the same object, referenced from two places. `JSON.parse` returns two equal but separate objects, so the `===` lookup finds nothing.
2. **zod drops what the schema doesn't list.** Parsing strips unknown keys by default. Plain assignability between `z.infer<schema>` and the domain type doesn't catch it either: a field that is optional on one side still assigns both ways.
3. **A file can be edited.** The producer never writes `kind: "publish"` over a round that failed a gate, but a person or a bug can. Checking the file's shape lets that combination through.
4. **A key that used to be minted at write time now comes from outside.** Before #245, every writer minted a fresh run id inside `newPublication()`, so `(run_id, round)` was unique without anyone enforcing it. Once the run id travels in a file, nothing stops the same id arriving twice.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** Causes 1 and 2 fail silently. Nothing throws; a held summary prints "no verdict", or a stored round is missing a field. The only feedback is a test that compares the round-tripped value's *behavior* with the original's. Cause 4 is a guarantee that held "by construction" while one writer minted the key. Moving the key outside removed that guarantee without changing any line that relied on it.

## Rule Scope

- **Applies when:** a domain value leaves memory and is later trusted as if it never left. That covers a preview or cache file, a queue message, or a value stored and read back. It applies most when downstream code looks things up by identity (`===`, `Map` or `Set` keyed by object, `indexOf`), when a schema library parses the value back, or when the file can be edited or replayed.
- **Inverts or does not apply when:** the value is plain data that every consumer compares by value. There, a schema check on its shape is enough, and adding an index field only adds a second source of truth. It also doesn't apply when the file is a log nobody acts on.
- **Sibling docs:** `db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` (cause 4 is the same pattern: a re-runnable write needs a DB-enforced key, here because the key became caller-supplied).

## Solution

One fix per cause, all in `src/pipeline/recheckPreview.ts` and `src/db/schema.ts` (PR #245):

1. **Record identity as an index, and relink on read.** `encodeRecheckPreview` writes `bestRound`, the index of the round whose draft *is* `best`. `decodeRecheckPreview` sets `best` to `rounds[bestRound].draft`, the object itself, so identity lookups work again. It refuses the file when that round's text differs from the saved `best`. The test "prints the same gate evidence for a held outcome read back from its preview file" pins the relink. Removing the relink makes it fail; that was checked by mutation.

   ```typescript
   const draft = rounds[bestRound]?.draft;
   if (draft === undefined || draft.prose !== rest.best.prose || /* highlights */) throw …;
   const best: WriteUp = draft; // the round's object, not the parsed copy
   ```

2. **Fail `tsc` when the schema and the domain type differ at all.** `_schemaMatchesDomain` asserts exact type equality with the generic-function conditional trick (`Same<A, B>`). Before comparing, `Plain<T>` strips `readonly`, because zod infers mutable types. `OmitEach<T, K>` distributes `Omit` over the union, because a plain `Omit` on a union keeps only the keys common to every variant. It costs nothing at runtime.

3. **Validate the invariants, not just the shape.** Decode refuses a file that is not `held` but whose best round has `gateFailures !== 0`. That covers the combination the producer never writes and an edit can.

4. **Enforce the key in the database.** `summary_rounds` gained `uniqueIndex("summary_rounds_run_id_round_unique").on(runId, round)` (migration 0010). The insert runs inside `replaceSummaryText`'s transaction, right after the summary `UPDATE`. A second apply therefore fails on the index, and the rollback undoes the update too. Test fixtures that shared the literal run id `"test-run"` moved to `crypto.randomUUID()`: the `publicationOf` default, and a getter in `StorageService.test.ts`.

## Prevention

**Code-level:** All four fixes have tests or compile checks (named above, and the "applied twice", "best draft was edited" and "fails a gate" tests in `src/pipeline/rewrite.test.ts`). For the next serialized domain value, write the round-trip test first: encode, decode, then assert that every consumer of the value (printers, lookups, storage) gives the same result for the decoded value as for the original. A test comparing only the JSON, or only the stored text, would have passed causes 1 and 2.

**Process-level:** When a slice adds a file, cache or message that carries a domain value, its boundary map should list four things: what code looks the value up by identity, how schema drift is caught, which invariants decode re-checks, and which key used to be unique by construction. #206 extends this file to `--all`. It must keep one run id per meeting, because the index is on `(run_id, round)`, not on the meeting.

## Planning / Calibration Notes

- **What widened the work:** The first commit did the save and the apply. Review added four commits: the gate-invariant refusal, the `.context/` ignore, the unique index with its production migration, and the compile-time schema check. Each was one of the causes above. A "write it to a file" slice grew a migration.
- **Future planning adjustment:** Size any slice that persists a domain value for a later trusted read as touching storage, even when the plan says "a local JSON file". Budget for decode-side invariants and a schema-drift check from the start.

## Defect Classification

**Origin phase:** Design error. #243's plan said "cache the outcome in a file". It did not say the file must reproduce the outcome exactly, or that identity and an outside key were involved.
**Fix type:** Correction.

## Key Decision

**Decision:** Store the best round's index and relink, rather than make `gateEvidence` match drafts by value.
**Rationale:** Matching by value can return the wrong round when two rounds wrote identical text but got different verdicts, and it would leave the in-memory path different from the file path. The index keeps one lookup for both paths, and decode can verify the index.
**Alternatives considered:** Matching by value in `gateEvidence`. Storing the gate evidence strings in the file instead of recomputing them; that duplicates derived data that could then disagree with the rounds.
**Revisable:** Yes. If `PrePublishOutcome` stops sharing the draft object between `best` and `rounds` (for example `best` becomes a round index in the domain type itself), drop `bestRound` and the relink.

## Defect clustering

This is the second recording of the pattern in `db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` (cause 4: a re-runnable write needs a DB-enforced key). It ships with its mechanism, the unique index and the "if the same saved preview is applied twice" test. Causes 1 to 3 are a different pattern. The nearest entry is `empty-output-silent-degradation-2026-04-11.md`, which shares "fails silently" but is about a stage producing nothing, not a value changing across a boundary.

## Related

- Issue #243, PR #245 (merged as `f700ba2`)
- PRD #193 user story 5; issue #206 (`--all` reuses the file format)
- `docs/solutions/patterns/db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md`
- `docs/solutions/devops/hand-applied-migration-must-precede-merge-2026-10-20.md` (migration 0010 was applied before the merge)

## Shelf Life

Stable while `summaries:recheck` saves a `PrePublishOutcome` to disk. The general rule (identity, schema drift, decode-time invariants, outside keys) is evergreen for any value that crosses a serialization boundary and is trusted afterwards.
