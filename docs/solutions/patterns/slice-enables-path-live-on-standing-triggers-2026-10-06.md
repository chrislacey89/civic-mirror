---
date: 2026-10-06
category: patterns
problem_type: silent production degradation
components: [pipeline, cli, ingest-workflow, composition]
technologies: [github-actions, effect]
severity: high
volatility: evergreen
---

# A slice that enables a path is live on every standing trigger the day it merges

## Problem

A tracer slice added the configuration that turns a new ingestion path on. The safeguards for that path's production writes belonged to later slices. Nothing in the slice said the path should stay off until then, so on merge the weekly schedule, a default manual dispatch and a no-flag local run would all have executed it against production.

## Context

PRD #127 adds video transcripts as a second source for meeting summaries. Slice #130 is its tracer: read the Town Council playlist, and store a video-only meeting for any video whose meeting does not exist yet. Its boundary map said to add the playlist, a title prefix and a 2025-05-27 start date to `DEFAULT_BODIES`.

The PRD also set conditions for writing videos to production:

- #115 must repair six January to March 2026 meetings that production holds collapsed onto 2026-05-14, or their videos become video-only meetings beside the collapsed one.
- A video with no meeting on its own date but one within two days (the July 14, 2026 title against the 2026-07-13 meeting) must be held as `near-date`, not stored. #134 builds that hold.
- #137, the backfill slice, asks for a database backup first.

Those conditions were written on #137 and in the PRD's dependency notes. Slice #130 carried none of them. It carried the sentence "Scheduled runs are unchanged", which was true of the workflow file and false of what the schedule would do once the playlist was configured: `runPipelineForBody` runs every source a body has.

The slice was built to its issue, passed every `/execute` tier that applied, and reached review with 317 green tests. An independent reviewer raised it as the top Concern on PR #139.

## Symptoms

Before merge there are none, which is the point. Signs that a slice is in this position:

- The diff adds an entry, flag or ID to a default configuration list (`DEFAULT_BODIES` here) and no trigger passes a filter.
- A sibling slice is named "Backfill", "Enable" or "Roll out", and carries preconditions.
- The PRD says "must be repaired before" or "held, not stored" about data the new path writes.
- The slice issue asserts that a trigger is unchanged by pointing at the trigger's file, not at what the trigger runs.

## Root Cause

The precondition was attached to the slice that names the risky operation (the backfill), not to the first slice whose merge makes the operation reachable. A backfill and a weekly run are the same code path here. The only difference is who starts it, and a schedule starts it without anyone deciding to.

Review then found the entry points one at a time. The first fix made the schedule pass `--sources egov,finalsite`. The second review found that a manual dispatch with untouched inputs still ran every source. A no-flag `pnpm pipeline run` still does.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The check that a path is safe to run sits with the slice that plans to run it deliberately. The schedule runs it first. The first feedback would have been duplicate meetings on the public site, noticed whenever someone next opened those dates.

## Rule Scope

- **Applies when:** a slice adds configuration, a default or a registration that a standing trigger reads (a cron workflow, a manual job's default inputs, a CLI's no-flag behaviour), and a later slice or an open issue owns a safeguard for what that path writes.
- **Inverts or does not apply when:** the path only reads, or only writes rows a later slice can replace without trace. Also when the capability is reachable solely through an explicit, named invocation, such as `drama:detect --video-id`: a person choosing to run it is the gate.
- **Sibling docs:** `placeholder-stubs-in-production-paths-2026-04-10.md` covers the neighbouring shape, where the unfinished part is inside the path (a stub) and the fix is a fail-fast guard. Here the path is finished and the unfinished part is around it.

## Solution

Ship the capability off on every standing trigger, and name the slice that turns it on.

List the triggers once, before choosing a fix. For this repo:

| Trigger | What decides the sources | State after PR #139 |
|---|---|---|
| Weekly schedule | `ingest.yml` run step | passes `--sources egov,finalsite` |
| Manual dispatch | the `sources` input | defaults to `egov,finalsite`; video runs when someone names `youtube` or clears the field |
| Local `pnpm pipeline run` | `--sources`, default all | still runs every source |
| `pnpm pipeline:dry` | never stores | safe |

The filter is a stopgap with an owner. It has to come out when #137 lands, or the weekly run never picks up new videos.

## Prevention

**Code-level:** No executable check reads `.github/workflows/ingest.yml`, so the schedule filter is held only by reading it. A test that runs the workflow's shell step under bash for each event and asserts the resulting command line came closest. It was left out because it pins this one gate, which is due to be removed, and not the pattern.

**Process-level:** At decomposition, attach each production-write precondition to the earliest slice whose merge makes that write reachable from a standing trigger, or have that slice ship the path disabled on those triggers. At execute time, list the triggers before verifying. Filed against the pipeline as chrislacey89/skills#394.

**Clustering:** this is the second entry on "an intentionally incomplete slice is live on the default production path", after `placeholder-stubs-in-production-paths-2026-04-10.md`. That entry produced a check for placeholders wired as defaults. The check did not fire here because nothing in this slice was a placeholder. The mechanism for this recurrence is the filed issue above.

## Planning / Calibration Notes

- **What widened the work:** two review-and-fix rounds for one Concern, because entry points were discovered per round.
- **What tightened the work:** running the title rule against the real playlist (156 titles, none refused) and one read-only query against production showing which dates already had meetings. That query is what made the two affected groups concrete.
- **Future planning adjustment:** when a PRD has a backfill slice, ask of slice 1: "after this merges, what does next Sunday's run write?"

## Related

- PR #139, issues #127, #130, #134, #137, #115
- chrislacey89/skills#394
- `docs/solutions/patterns/placeholder-stubs-in-production-paths-2026-04-10.md`

## Shelf Life

Evergreen as a rule. The trigger table goes stale when #137 removes the schedule filter.
