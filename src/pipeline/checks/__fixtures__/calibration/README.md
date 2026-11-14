# Judge calibration corpus (#195)

`corpus.json` holds 90 hand-made edits of published meeting-summary drafts. They
measure how often the model judge catches gate failures and how often it refuses
a draft that is fine, on rubric gates A2 (no opinion, motive or loaded words),
A4 (terms of art say what the motion said) and A5 (officials by name, the public
by count). See `docs/writing-rubric.md` § A.

Claude authored the corpus on 2026-11-03 for issue #195. The base drafts are 19
meetings whose drafts a previous scorer passed on A2, A4 and A5.

## What an entry is

Each entry makes exactly one change, to one highlight or one prose sentence of one
base draft. Every check has 15 fail edits (`<check>-F-nn`) and 15 pass edits
(`<check>-P-nn`). A pair (`pairId`) shares a base draft and location, and the two
length changes are within 15 characters of each other. That keeps shallow
features such as length, names, numbers and commas from separating the labels.

The labels hold by construction. A fail edit breaks only its target check, and a
pass edit keeps all three gates. Each `rationale` points to the source passage
that decides the label. Real residents' names never appear in it.

- **A2 fails** mostly use judgment or motive language that `LOADED_WORDS` does not
  list ("sensibly", "fretted", "played this down", "in a bid to..."). Only two use
  listed words.
- **A5 fails** name a resident who spoke at public comment. **Every such name is
  invented**, and none appears in any source. Code cannot catch these: an invented
  name is never inside the minutes' public-comment section. Because an invented
  name is in no source, these drafts also fail A1. The labels here cover only
  A2, A4 and A5.
- **A5 passes** name officials, staff or vendors with their roles, spelled as the
  documents spell them, or refer to residents by count.

## Applying an edit

The fixture holds only the edits. The base drafts and their sources are loaded
from the database at run time, by `baseKey` (the meeting key). To build the edited
draft, do an exact-string replace of `before` with `after` in the target field:

- `target.field = "highlights"`: `highlights[target.index]` equals `before`. Replace it.
- `target.field = "prose"`: `target.sentence` equals `before`, and it occurs exactly
  once in the prose. Replace that one occurrence.

If `before` is missing, the stored draft has changed since 2026-11-03, and that
entry no longer applies.

`sourceKind` records whether the meeting has documents or only a caption
transcript. All A5 pairs are on documents meetings. In the four transcript-only
base meetings, no resident spoke at public comment.

## Re-running it

`pnpm tsx src/pipeline/scripts/calibrate-judge.ts --write` applies every edit, leaves out the ones a code check catches, has the production judge check the rest twice, and writes `record.json`. `judge-record.test.ts` fails whenever the judge's model, prompt or settings no longer match the record, or a gated check in `JUDGE_GATED` no longer clears the bars in `src/pipeline/checks/calibration.ts`. `--dry` shows what would be scored without calling the model.
