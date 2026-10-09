# Writing rubric for meeting write-ups

This scores the two pieces of text a resident reads on a meeting page: the
`highlights` list and the `prose` paragraph that the summarizer produces. It
does not score the fiscal ledger; rules 1–20 of the summarizer's system prompt
already govern that.

Where the text lands on the site decides what each piece has to do:

| Field | Where it shows | What it has to do |
|---|---|---|
| `highlights[0]` | The `<h1>` of the meeting page, and the first line of the meeting card | Be the headline. One fact, ~12 words or fewer, readable at 54px. |
| `highlights[1..2]` | The meeting card (first three highlights only) | Carry the next two most important facts. |
| `highlights[3..]` | The meeting page only | Everything else worth a line. |
| First sentence of `prose` | The lede under the `<h1>` | Add a fact the headline did not give. Stand alone. |
| Rest of `prose` | The summary section | Tell what happened, in order of importance, in paragraphs of two to five sentences; length scales with the meeting (see D6). |

Paragraph breaks are blank lines in `prose`; the meeting page splits on them
(`$date.tsx`, since 2026-10-09). The home page's lead card still renders the
whole `prose` in one `<p>` (`index.tsx`), which is a separate fix.

The books behind this: Zinsser *On Writing Well*, Pinker *The Sense of Style*,
VandeHei/Allen/Schwartz *Smart Brevity*, Klinkenborg *Several Short Sentences
About Writing*, Heath *Made to Stick*. Each check cites its source as
`book-slug/references/file.md` in `~/.claude/library/books/`. Checks marked
**house** come from Civic Mirror's own promises (neutral, every figure
traceable), not from a book; the books say nothing about figure traceability.

## How to score

Section A is a gate. A write-up that fails any A check is not publishable,
whatever it scores elsewhere. Sections B–G are 1 point per check, 26 points
total. Scoring is deliberately mechanical: each check is a yes/no an editor
can answer in under ten seconds, so two people get the same number.

Target for a prompt change to count as an improvement: no A failures, and a
median of 23 or more across the sampled meetings. The output **before the
writing prompt existed** (`gemini-2.5-flash`, scored 2026-10-09 on four
meetings) scored
12–16 and failed gate A5 on two; see "Where the output failed before the writing
prompt" below. The four meetings used to tune this rubric are 2026-05-26,
2026-08-10, 2026-07-27 and 2026-10-05; `summarize-repeat --json` regenerates
their text for scoring.

## A. Fidelity gates (house)

- **A1. Every figure, name and vote is in a source.** Dollar figures copied as
  the record writes them. Vote counts only when the record states them. No
  figure is estimated, rounded, annualized or added up unless the record adds it
  up. *Test: pick any number in the text and find it in DOCUMENTS or
  TRANSCRIPT.*
- **A2. No opinion, no motive, no loaded words.** No "sparked debate",
  "controversial", "finally", "only", "merely", "sadly". Attribution verbs are
  *said*, *asked*, *told*, *voted*, *moved*; never *admitted*, *claimed*,
  *insisted*, *pointed out*. *Test: circle every attribution verb and every
  adjective of judgment.* (`william-zinsser-on-writing-well/references/writing-forms.md`;
  Process Watch prompt, "No loaded words")
- **A3. No source artifacts leak.** The write-up never says "the transcript",
  "the minutes state", "an internal contradiction", or quotes a garbled caption
  ("1 million JD460"). Where the two sources disagree the summarizer records it
  in `sourceDisagreements`; the prose uses the DOCUMENTS figure and says nothing
  about the disagreement. *Test: search for transcript, minutes, record,
  stated as, noted that.*
- **A4. Each sentence says what the source says, not what it was meant to
  say.** Terms of art keep their meaning: *tabled* is not *denied*; *first
  reading* is not *adopted*; *recommended* is not *approved*; *conditional on*
  is stated when the motion was. *Test: for every tabled/approved/adopted/
  recommended/introduced, find the motion and check the word.*
  (`several-short-sentences-about-writing/references/core-framework.md`,
  `.../vocabulary-and-etymology.md`)
- **A5. Officials by name and role; the public by count.** Council members,
  staff, applicants and presenters from organisations may be named as DOCUMENTS
  spells them, with their role on first mention. Residents speaking at public
  comment are "a resident", "four residents", or "the owner of a Main Street
  business", never by name. On a transcript-only meeting, where captions carry
  no speaker labels, most speakers become "staff" or "a council member"; that
  is expected, not a defect (writing prompt rule 10). *Test: every proper
  name belongs to someone with a role in the item, and is spelled as DOCUMENTS
  spells it.* (Process Watch prompt, "Naming people"; decided 2026-10-09)

## B. Headline: `highlights[0]` (4 points)

- **B1. It is the one thing you would shout.** The single most consequential
  decision or event of the meeting, not the first agenda item. Minutes approval,
  paying the bills, prayer, roll call and adjournment are never the headline.
  *Test: would a resident who read only this line know the main thing that
  happened?* (`smart-brevity/references/lede-craft.md`, Elevator Shout Test;
  `chip-heath-made-to-stick/references/simple.md`, "if you say three things,
  you've said nothing")
- **B2. Actor, verb, object, in the first four words.** "Council approves
  $139,775 street resurfacing bid", not "Approval of bid for resurfacing
  project". A label fails; a fact passes. When the meeting took no vote (a
  public hearing, a presentation), the headline leads with the finding
  instead: "A $200,000 town home pays $64–$66 more under either 2027 budget".
  When the biggest item was public comment that ended with no decision, the
  headline says what was asked and the lede says what the town said it would
  do. *Test: read the first four words alone.*
  (`smart-brevity/references/tease-and-headlines.md`, "Reid Won't Seek
  Reelection"; `.../word-power.md`; Process Watch prompt, "Framing rule")
- **B3. Twelve words or fewer, no clause after a comma.** *Test: count.*
  (`smart-brevity/references/rules-of-thumb.md`, headlines six words where
  possible; the twelve-word ceiling is house, set by the `<h1>` width)
- **B4. Concrete object.** A street, parcel, vehicle, dollar sum, ordinance's
  effect, person's job. "Street resurfacing on five streets", not
  "infrastructure improvements". *Test: can two residents picture the same
  thing?* (`chip-heath-made-to-stick/references/concrete.md`)

## C. Lede: first sentence of `prose` (4 points)

- **C1. It adds a fact the headline did not give.** Usually the *why* or the
  *for whom*: what the money buys, what the ordinance changes, what happens
  next. It never restates `highlights[0]` in other words. *Test: cover the
  headline; does the lede still tell you something new? Then cover the lede; is
  anything lost?* (`smart-brevity/references/implementation-playbook.md`, "the
  most commonly violated rule")
- **C2. No scene-setting.** The lede never opens with the body convening, the
  date, the time, the prayer, the roll call, or "held a regular meeting".
  The date and body are already on the page. *Test: does the sentence survive
  if you swap in a different meeting's date? If so, it is scene-setting.*
  (`william-zinsser-on-writing-well/references/leads-and-endings.md`,
  breakfast-to-bed; `smart-brevity/references/lede-craft.md`)
- **C3. Stands alone.** It is rendered by itself under the `<h1>`, so no
  pronoun without a referent, no "also", no "the proposal" before the proposal
  has been named. *Test: read it with nothing above it.*
  (`several-short-sentences-about-writing/references/core-framework.md`)
- **C4. Twenty-five words or fewer.** *Test: count.* (`smart-brevity/references/
  rules-of-thumb.md`, a takeaway under 12 words; the 25 ceiling is house)

## D. Selection and order (6 points)

- **D1. Importance order, not agenda order.** Money, votes that change what
  residents can do, hires and departures of senior staff, and anything a
  resident could still act on (a hearing date, a comment period) come before
  recognitions, announcements and reports. The prose does not have to mention
  every ledger entry; the receipts table on the page carries the rest, so a
  twelve-decision meeting gets paragraphs only for the decisions that change
  something for residents (length itself is D6). *Test: is the first paragraph
  sentence after the lede about a lower-stakes item than a later one?*
  (`smart-brevity/references/newsletters-and-email.md`; `several-short-
  sentences-about-writing/references/composition-and-revision.md`, "Don't
  ration it")
- **D2. Meeting mechanics are cut.** Call to order, prayer, pledge, roll call,
  who presided, minutes approval, adjournment time, "no further business".
  One exception: an absence or a recusal that affected a vote. Paying the bills
  is mentioned only if a specific invoice was questioned. *Test: search for
  convened, called to order, pledge, roll call, adjourned, minutes.*
  (`william-zinsser-on-writing-well/references/clutter-and-compression.md`)
- **D3. Every item a resident could act on is kept, with its date.** Public
  hearings, comment deadlines, budget adoption dates, first readings whose
  adoption vote is still to come. *Test: list the forward-looking dates in the
  source; are they in the text?* (house; Smart Brevity's "What's next")
- **D4. Three to six highlights, one fact each, 20 words or fewer, none
  duplicating the lede.** Highlights are parallel: each begins with the actor
  or the thing decided, and each stands alone on the card. *Test: count, then
  read each cold.*
  (`smart-brevity/references/axioms-and-formatting.md`)
- **D5. Paragraphs of two to five sentences, one item each.** A new paragraph
  when the item changes, never more than five sentences in one, and the first
  paragraph is the lede's item. A one-sentence paragraph is allowed only for a
  recognition or an announcement at the end. *Test: count sentences per
  paragraph; name each paragraph's item in two words.*
  (`smart-brevity/references/axioms-and-formatting.md`, paragraphs of 2–3
  sentences; the ceiling of five is house)
- **D6. Length scales with the meeting, anchored at 300–400 for the largest.** At least 80
  words. A routine meeting lands near 150–200; a meeting with a dozen
  decisions or hours of discussion needs 300–400, and compressing it below
  what its items need fails this check as surely as padding a short one does.
  Past 400 the prose is repeating the ledger table: a paragraph per ledger
  row is the sign. The limits that hold are structural: one item per paragraph (D5),
  mechanics cut (D2), ledger entries not repeated (D1). *Test: count the items
  the prose covers; is any covered in fewer than two sentences, or any routine
  item in more than five?* (house; decided 2026-10-09 — "if it is a 4 hour
  meeting 250 words may even be on the low end")

## E. Sentences (4 points)

- **E1. The body does the verb.** "The council approved", "members voted
  4–0", "the town manager said". A passive is allowed only when the thing done
  is the topic the previous sentence set up, or the actor is genuinely unknown.
  "Mistakes were made" sentences fail. *Test: circle every was/were + past
  participle; is the actor named within the sentence or the one before?*
  (`steven-pinker-sense-of-style/references/passive-voice-toolkit.md`;
  `william-zinsser-on-writing-well/references/business-writing.md`)
- **E2. Verbs, not zombie nouns, for first mention.** "approved the bid", not
  "approval of the bid was granted"; "added $52,000 to the fire budget", not
  "an additional appropriation of $52,000 was approved". A noun form is fine
  when referring back to an event already told. *Test: circle -tion/-ment/
  -ance nouns after "the" or "of".* (`steven-pinker-sense-of-style/references/
  nominalization-zombie-nouns.md`)
- **E3. One thought per sentence; 30 words is the ceiling, 18 the average.**
  Split at "and", "while", "with", and semicolons. *Test: count the longest
  sentence; count the average.* (`william-zinsser-on-writing-well/references/
  micro-tools.md`; the numbers are house)
- **E4. Varied openings, steady names.** No three consecutive sentences
  starting with the same word. One name per actor throughout: "the council" is
  never also "the board" or "the governing body"; "the town manager" is not
  later "Farmer". *Test: list first words down the column; list every label
  used for each actor.* (`several-short-sentences-about-writing/references/
  revision-by-ear.md`, the column test; `steven-pinker-sense-of-style/
  references/arcs-of-coherence.md`, no elegant variation)

## F. Words (4 points)

- **F1. No officialese.** The record's own phrases are translated, not copied.
  The hit-list, with the plain replacement:

  | In the record | In the write-up |
  |---|---|
  | convened; called to order | met (or cut, see D2) |
  | entertained a motion to approve | approved |
  | Accounts Payable Vouchers and Payroll | paid its bills (usually cut) |
  | authorized the payment of | paid |
  | Privilege of the Floor | public comment |
  | additional appropriation of $X for Y | added $X to the Y budget |
  | transfer of $X from A to B | moved $X from A to B |
  | in the amount of $X | $X |
  | first reading of Ordinance N, which … | introduced an ordinance that would … (a vote to adopt comes later) |
  | adopted on second reading | adopted |
  | tabled | put off; tabled (say until when, if stated) |
  | Resolution 13-2026 approved a transfer | the council moved … (resolution number goes in the ledger, not the prose) |
  | contingent upon; pending | if; once |
  | utilize, commence, prior to, subsequently, in anticipation of | use, start, before, then, ahead of |

  *Test: search for each left-hand phrase.* (`william-zinsser-on-writing-well/
  references/clutter-and-compression.md`, `.../business-writing.md`;
  `smart-brevity/references/word-power.md`, the bar test)
- **F2. Jargon is glossed or replaced on first use.** Acronyms spelled out
  and, where the name does not explain itself, told what the thing does. The
  town's recurring ones:

  | Term | Gloss |
  |---|---|
  | MVH fund | the Motor Vehicle Highway fund, the town's main road-money account |
  | PERF physical | the physical required by the state police and fire pension fund |
  | UDO | Unified Development Ordinance, the town's zoning and building rules |
  | IURC | the state utility regulator |
  | TIF | tax-increment financing district, which keeps some property tax for local projects |
  | Community Crossings | a state matching grant for local roads |
  | C-2 → R-2 | from commercial to medium-density residential zoning |
  | reorganization | the proposed merger of the town and Richland Township |
  | claims | the town's bills |

  *Test: underline every capitalised term and acronym; is it glossed or
  replaced?* (`steven-pinker-sense-of-style/references/curse-of-knowledge.md`;
  `chip-heath-made-to-stick/references/core-framework.md`)
- **F3. No hedges, no filler, no announcers.** Cut "it should be noted",
  "various", "several items", "a number of", "discussion ensued", "a lengthy
  discussion", "largely", "somewhat". Attribution ("staff estimated") is not a
  hedge and stays. *Test: search the list.* (`william-zinsser-on-writing-well/
  references/micro-tools.md`; `several-short-sentences-about-writing/
  references/the-anxiety-of-sequence.md`, no merely transitional sentence)
- **F4. Plain words a neighbour uses.** *Residents*, not *the public* or
  *citizens*; *pay*, not *fund*; *rules*, not *regulations* where the record
  allows; *bar*, not *establishment*. *Test: the bar test on every noun and
  verb in the lede and headline.* (`smart-brevity/references/word-power.md`;
  `william-zinsser-on-writing-well/references/clutter-and-compression.md`)

## G. Numbers (4 points)

- **G1. The figure appears as the record writes it, once.** The ledger keeps
  the record's exact string ($29,425.00, $139,775.03). Prose and highlights
  drop a trailing ".00" and nothing else: $29,425 passes, $139,775.03 stays
  as written, $139,775 fails. Never both "$2.2 million" and "$2,200,000" for
  the same sum. A figure the record states only in garbled form ("$11,767"
  for a total whose parts are each stated cleanly) is left out; the parts are
  given instead. *Test: compare each prose figure to its ledger
  `originalAmount`.* (house, rule 6 of the ledger prompt)
- **G2. Scale comes from the record or not at all.** "$66 more a year on a
  $200,000 home" is in the record and goes in. "Roughly a tenth of the police
  budget" is not in the record and stays out, however helpful. *Test: for every
  comparison or per-household figure, find the sentence in the source.*
  (`chip-heath-made-to-stick/references/credible.md`, statistics as input, and
  the warning that reframing "can make them deceptive"; A1)
- **G3. The vote is given when the record gives it.** "4–0", "unanimously",
  "with Swafford opposed". Not "the council approved" when a 3–2 is in the
  record. *Test: compare each approval to the roll call.* (Process Watch
  prompt, "Report vote counts plainly"; A1)
- **G4. A sum with no stated amount says so.** "The council paid its bills; no
  total was read into the record." *Test: any decision in the ledger with
  `originalAmount` "not stated" that the prose gives a number for is a fail.*
  (house, rule 2 of the ledger prompt)

## Where the output failed before the writing prompt

Taken from the ten most recent stored summaries on 2026-10-09, before the
prompt carried any writing rules. Each pair is the stored text and a rewrite
that passes the check named.

**B1, B2 — headline is the minutes approval.** The `<h1>` of the 2026-09-28
page reads:

> Town Council approved the minutes from the September 14, 2026 meeting and the
> payment of accounts payable and payroll vouchers.

Rewrite: *Council turns down $140,000 request for Area 10 bus service.*

**C2 — every lede is scene-setting.** All ten begin "The Ellettsville Town
Council convened on …". 2026-05-26:

> The Ellettsville Town Council convened for a regular meeting on May 26, 2026,
> led by President Scott Oldham.

Rewrite: *Milestone Contractors will resurface five streets after the council
accepted its $139,775.03 bid, the lowest of three.*

**E1, E2, F1 — officialese and zombie nouns.** 2026-08-24:

> The council approved the minutes from the August 10, 2026 meeting and
> authorized the payment of Accounts Payable Vouchers and Payroll.

Rewrite: cut (D2).

> Resolution 16-2026 allocated an additional $52,000 to the Fire Department
> for overtime due to staffing shortages and increased calls.

Rewrite: *The council added $52,000 to the fire department's budget for
overtime, which the chief attributed to open positions and more calls.*

**F2 — jargon unglossed.** 2026-07-27: "MVH restricted funds", "UDO", "PERF
physicals", "Community Crossings grant", each with no gloss.

**A3 — artifacts leak.** 2026-10-05:

> administration (stated as '1 million JD460') … though an internal
> contradiction in the transcript noted a '$150 difference' which was affirmed.

Rewrite: give the DOCUMENTS figure, or when there are no documents, give the
figure the transcript states cleanly and leave out the one that is garbled.

**D2 — mechanics.** 2026-07-27 runs 431 words, 2026-08-10 348, both opening
with prayer and pledge; most of the length is ceremony and agenda order, not
items.

**D5 — paragraphs.** 2026-07-27 (431 words) and 2026-10-05 (273) are each one
paragraph. 2026-08-10 breaks into four, but the last runs six sentences.
2026-05-26 is the one that passes: three paragraphs of three, three and five.

**A5 — residents named.** 2026-08-10 names four residents who complained
about a bar at public comment, and 2026-06-22 names a business owner and
co-owner disputing a fine.

## Scoring sheet

```
Meeting: ______________________   Scorer: ______   Date: ______

A  gates     A1 A2 A3 A4 A5          any fail → not publishable
B  headline  B1 B2 B3 B4             __ /4
C  lede      C1 C2 C3 C4             __ /4
D  selection D1 D2 D3 D4 D5 D6       __ /6
E  sentences E1 E2 E3 E4             __ /4
F  words     F1 F2 F3 F4             __ /4
G  numbers   G1 G2 G3 G4             __ /4
                                     __ /26
Prose words: ____   Longest sentence: ____   Highlights: ____
Paragraphs: ____    Most sentences in one: ____
```

## Open decisions

1. **Naming the public (A5) — decided 2026-10-09.** Officials, staff,
   applicants and organisation presenters by name; residents at public comment
   by count, never by name. A business owner disputing their own matter at
   public comment is a resident.
2. **Rounding in prose (G1).** The rubric drops a trailing ".00" and keeps
   every other cent, so prose matches the ledger to the dollar and the headline
   is not "$29,425.00". The stricter alternative (copy every string exactly)
   and the looser one (round to the dollar in prose) are both defensible; this
   is the middle.
3. **Where the rubric is enforced.** `WRITING_INSTRUCTIONS` in
   `src/pipeline/services/GeminiSummarizer.ts` carries sections B–G, in a
   second model call that receives the ledger the first call extracted; the
   meeting page splits `prose` on blank lines; `summarize-repeat.ts --json` exports
   each run's text for scoring. What the repeat runs taught about writing
   rules in a shared extraction prompt is in
   `docs/solutions/patterns/writing-rules-in-an-extraction-prompt-leak-into-the-extraction-2026-10-09.md`.
   What is still open (long transcript-only meetings run past the D6 anchor
   and keep "additional appropriation"; the home page lede; a code-side length
   signal) is issue #187, not this file.
