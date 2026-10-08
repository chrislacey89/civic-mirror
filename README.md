# Civic Mirror

**A local newspaper for a town that lost one.**

Civic Mirror reads the public meetings of local governing bodies in Ellettsville and Monroe County, Indiana, and writes them up for residents. Each meeting gets highlights, a plain-language summary, and a ledger of fiscal decisions. Every figure links back to the source document so readers can check it themselves.

No ads, no paywall, no political slant. It covers what elected officials actually did this week.

**Live:** [civic-mirror-rho.vercel.app](https://civic-mirror-rho.vercel.app)

## What it covers

The site tracks eight bodies: the Ellettsville Town Council, Plan Commission, Parks & Recreation Board, Board of Zoning Appeals, and Redevelopment Commission; the Monroe County Commissioners and County Council; and the Richland-Bean Blossom School Board.

The weekly pipeline currently ingests four of them: the Ellettsville Town Council, the Ellettsville Plan Commission, the Monroe County Commissioners, and the Richland-Bean Blossom School Board. The other four are next.

## How it works

1. **Collect.** Agendas, minutes, and ordinances come from public portals (Ellettsville's eGov document center and the school district's Finalsite pages). Meeting videos come from YouTube.
2. **Extract.** PDF text is extracted directly. Scanned PDFs go through OCR, and a document that can't be read at all is kept as "unreadable" instead of silently producing an empty summary. The one exception is a meeting that so far has only a video: an unreadable PDF for it is skipped and logged rather than kept, so the first readable PDF still gets the same-meeting check against the video.
3. **Summarize.** Gemini turns each meeting into highlights, a prose summary, and structured fiscal decisions.
4. **Publish.** Results land in a Turso (libSQL) database and are served by a TanStack Start app.

A GitHub Actions workflow runs the pipeline every Sunday. Failures and zero-result runs send an email alert through Resend.

**Being honest about limits.** Figures that came from OCR carry a small `?` badge. Meetings whose documents couldn't be extracted show only a link to the source PDF. Civic Mirror is a starting point for an informed resident, not a replacement for the minutes.

**In progress: Process Watch.** Process Watch notes where a meeting's process broke down: unclear approvals, items revisited without resolution, and time spent without a decision. It scores how the body conducted its business, not whether its decisions were right. It's being added to the pipeline now.

## Stack

- **App:** TanStack Start (React 19, SSR), Tailwind CSS, shadcn/ui, Recharts
- **Pipeline:** Effect TS, Vercel AI SDK with Gemini, unpdf (PDF text) and tesseract.js (OCR), YouTube transcripts
- **Data:** Drizzle ORM on Turso / libSQL (SQLite locally)
- **Ops:** GitHub Actions (weekly ingest), Resend (alerts), Vercel (hosting)
- **Quality:** Vitest, Biome, Lefthook pre-commit hooks

## Running it locally

Requires Node 22 and pnpm.

```bash
pnpm install
cp .env.example .env.local   # fill in keys; see comments in the file
pnpm db:migrate
pnpm dev                     # http://localhost:3000
```

Without `DATABASE_URL`, local development uses a SQLite file (`dev.db`).

### Pipeline

```bash
pnpm pipeline list-bodies                     # show configured bodies
pnpm pipeline:dry                             # full run, no writes or alerts
pnpm pipeline:run                             # full run
pnpm pipeline run --body ellettsville-town-council   # one body only
pnpm pipeline:run --sources youtube           # video path only
pnpm pipeline held:list                       # videos the pipeline holds, and why
```

Ellettsville's eGov portal enforces a 300-second delay between PDF downloads. `--skip-crawl-delay` is for local testing only.

A video run also scores any stored video whose meeting has no Process Watch assessment, which is what a failed assessment leaves. It reads the stored transcript and changes nothing else on the meeting. A failed assessment counts in the run's `errors`. The weekly schedule does not run the video path, so this happens when a run names `youtube` in `--sources` or passes no `--sources`.

### Checks

```bash
pnpm test      # Vitest
pnpm check     # Biome lint + format
```

## Project notes

Lessons from building the pipeline, such as idempotent re-runs, silent-failure patterns, and LLM scoring drift, are written up in [`docs/solutions/`](docs/solutions/).
