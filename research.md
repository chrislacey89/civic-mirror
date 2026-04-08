# Research: Civic Mirror — Data Ingestion & Summarization Pipeline

**Date:** 2026-04-07
**Depth:** DEEP
**Domain:** Multi-source data ingestion, AI summarization, local government transparency
**Confidence:** HIGH
**Constraints from shape:** 🔒 8 governing bodies, 2-year lookback. TanStack Start SSR + Drizzle/SQLite + Effect TS pipeline + Vercel AI SDK + Shadcn. Railway deployment. Email failure alerts. Local script first, server cron later.

## 📦 Version Check

| Dependency | Installed | Latest | Status |
|-----------|-----------|--------|--------|
| react | 19.2.4 | 19.2.4 | ✅ Current |
| @tanstack/react-start | 1.167.16 | ~1.168 | ✅ No issues |
| @tanstack/react-router | 1.168.10 | ~1.168 | ✅ No issues |
| @tanstack/react-query | 5.96.2 | ~5.96 | ✅ No issues |
| drizzle-orm | 0.45.2 | 0.45.2 | ✅ Current |
| better-sqlite3 | 12.8.0 | 12.8.0 | ✅ Current |
| tailwindcss | 4.2.2 | 4.2.2 | ✅ Current |
| vite | 7.3.1 | 7.3.1 | ✅ Current |
| typescript | 5.7.2 | 6.0.2 | ⚠️ Major version — see VERSION CHANGE below |

**New dependencies to add:**

| Package | Version | Purpose |
|---------|---------|---------|
| `effect` | 3.21.0 | 📦 Core Effect library |
| `@effect/platform` | 0.96.0 | 📦 HTTP client, filesystem |
| `@effect/platform-node` | 0.106.0 | 📦 Node.js runtime (NodeRuntime.runMain) |
| `@effect/sql` | 0.51.0 | 📦 SQL toolkit |
| `@effect/sql-sqlite-node` | 0.52.0 | 📦 SQLite via better-sqlite3 |
| `@effect/cli` | 0.75.0 | 📦 CLI argument parsing |
| `ai` | 6.0.151 | 📦 Vercel AI SDK core |
| `@ai-sdk/google` | 3.0.59 | 📦 Gemini provider |
| `@ai-sdk/moonshotai` | 2.0.15 | 📦 Kimi/Moonshot provider |
| `zod` | latest | 📦 Schema validation (for AI SDK structured output) |
| `youtube-transcript` | 1.3.0 | 📦 YouTube caption extraction (TypeScript native) |
| `resend` | latest | 📦 Email alerts |

⚠️ **Effect v4.0 beta exists** — stick with stable v3.x. The 4.0 beta may introduce breaking changes.

🔄 **VERSION CHANGE (TypeScript 5.7 → 6.0):** Major release — final JS-based compiler. TS 7.0 will be rewritten in Go.
  - **`strict` now defaults to `true`** — already set in tsconfig, no action needed
  - **`module` defaults to `esnext`** — already set, no action needed
  - **`target` defaults to `ES2025`** — project has `ES2022`, consider updating to `ES2025`
  - **`types` defaults to `[]`** — already explicit (`["vite/client"]`), add `"node"` for pipeline server code
  - **`baseUrl` is deprecated** — project uses `"baseUrl": "."` with `paths`. Must inline prefix into `paths` entries and remove `baseUrl` before TS 7.0
  - **`esModuleInterop: false` removed** — interop always enabled, no impact (project doesn't set it)
  - **`moduleResolution: node10/classic` removed** — project already uses `"bundler"`, no impact
  - **`rootDir` defaults to `.`** — project doesn't set it explicitly, which now aligns with the new default
  - **Migration guide:** [TypeScript 5.x to 6.0 Migration Guide](https://gist.github.com/privatenumber/3d2e80da28f84ee30b77d53e1693378f) 🔗
  - **Official announcement:** [Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/) 🔗
  - **Action required:** Upgrade `typescript` to `^6.0.2` in package.json. Remove `baseUrl`, adjust `paths` entries. Minimal disruption expected for this project.

## 💡 Summary

Civic Mirror's core pipeline is technically feasible with high confidence. The architecture breaks into five stages — scrape, extract, transcribe, summarize, store — all orchestrated by Effect TypeScript's service pattern with typed errors and retry logic.

**Key findings that change or confirm the approach:**

1. **Fiscal extraction is proven.** Academic research ([arXiv:2511.10659](https://arxiv.org/abs/2511.10659)) demonstrates 84%+ accuracy extracting structured fiscal data from government documents using Gemini. Meeting transcripts are less structured than budget PDFs, but a two-pass extract+verify approach with a detailed Zod schema mitigates the risk. This was the most speculative assumption — it's now `Likely`.

2. **YouTube captions are inconsistent but extractable.** The `youtube-transcript` npm package (native TypeScript, 58K weekly downloads) can pull captions from videos that have them. The YouTube Data API v3 can cheaply check availability (~21 quota units for 500 videos). Videos without captions need audio download via yt-dlp + local Whisper.

3. **eGov portal is stable and scrapable.** Clean HTML tables with GET-based pagination, consistent CSS classes, and a legacy CMS (CORE Business Technologies eGov) that hasn't changed structurally in years. ⚠️ `robots.txt` specifies `Crawl-delay: 300` (5 minutes between requests) — the backfill will take time.

4. **Effect fits this pipeline well** but has a moderate-to-steep learning curve. The service pattern, typed errors, retry/scheduling, and `@effect/platform` HTTP client map directly to pipeline needs. Budget 1-2 weeks for ramp-up on core patterns. A published article specifically covers this pattern: ["Building a Fault-Tolerant Web Data Ingestion Pipeline with Effect-TS"](https://dev.to/prithwish_nath/building-a-fault-tolerant-web-data-ingestion-pipeline-with-effect-ts-29l1).

5. **Railway is the official TanStack Start hosting partner** with volume support for SQLite. ~$5-7/month with serverless sleep. Use Resend for email alerts (3,000/month free).

## Estimate Readiness

- **Target in play:** No hard deadline. Personal project + portfolio piece.
- **Current estimate posture:** Range. Pipeline development is 3-6 weeks depending on Effect learning curve. Frontend is 2-3 weeks. Backfill is ~2-3 nights of Whisper processing + several hours for eGov (crawl delay).
- **Commitment posture:** No commitment needed. Solo developer, no external stakeholders.
- **Main uncertainty drivers:** (1) Effect learning curve — could compress to 1 week or stretch to 3+ weeks. (2) Whisper quality on meeting audio — may need prompt tuning and audio preprocessing iteration. (3) Fiscal extraction prompt engineering — expect 2-3 iterations to get reliable results.

## 🚫 Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why | Docs |
|---------|-------------|-------------|-----|------|
| YouTube transcript extraction | Custom YouTube scraper | [`youtube-transcript`](https://www.npmjs.com/package/youtube-transcript) v1.3.0 | Native TypeScript, 58K weekly downloads, handles InnerTube API reverse-engineering | 🔗 [npm](https://www.npmjs.com/package/youtube-transcript) |
| YouTube video listing | Manual YouTube page scraping | YouTube Data API v3 `playlistItems.list` | Official API, 1 quota unit per 50 videos, structured JSON | 🔗 [API docs](https://developers.google.com/youtube/v3/docs/playlistItems/list) |
| LLM structured output | Manual JSON parsing of LLM responses | Vercel AI SDK [`Output.object()`](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) with Zod | Type-safe, streaming-capable, provider-agnostic, handles validation errors | 🔗 [AI SDK docs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) |
| HTTP client with retries | Custom fetch wrapper | `@effect/platform` [`HttpClient`](https://effect.website/docs/platform/http-client) | Built into Effect ecosystem, typed errors, composable retry policies | 🔗 [Effect docs](https://effect.website/docs/platform/http-client) |
| Email sending | SMTP directly | [`resend`](https://resend.com/docs) | 3K emails/month free, simple REST API, no SMTP config | 🔗 [Resend docs](https://resend.com/docs) |
| CLI argument parsing | Manual process.argv parsing | [`@effect/cli`](https://effect.website/docs/cli) | Integrates with Effect ecosystem, typed commands and options | 🔗 [Effect CLI docs](https://effect.website/docs/cli) |
| Audio transcription on M1 | Python openai-whisper | [whisper.cpp](https://github.com/ggergml/whisper.cpp) with Core ML | 4-6x faster than Python Whisper on M1, native Metal/ANE acceleration | 🔗 [GitHub](https://github.com/ggergml/whisper.cpp) |

## 🪤 Common Pitfalls

### 🪤 Pitfall: Effect Ecosystem Isolation
**What goes wrong:** Effect has its own HTTP client, error model, and DI system. Wrapping non-Effect libraries (Vercel AI SDK, youtube-transcript, yt-dlp child process) requires boundary code.
**Why it happens:** Effect describes work as values, not eager execution. Libraries that throw exceptions or return plain Promises need explicit wrapping.
**How to avoid:** Use `Effect.tryPromise()` at service boundaries to wrap Vercel AI SDK calls. Define services with `Context.Tag` and provide implementations via `Layer`. Keep Effect-aware code in the pipeline; keep library calls in service implementations. ([Effect error management docs](https://effect.website/docs/error-management/unexpected-errors)) 🔗
**Warning signs:** Untyped errors propagating through the pipeline; `Effect.runPromise()` calls scattered throughout instead of at the entry point only.

### 🪤 Pitfall: Temporal Confusion in Fiscal Extraction
**What goes wrong:** LLM confuses past spending references ("last year we spent $200K on roads") with new decisions, inflating extracted fiscal data.
**Why it happens:** Meeting transcripts constantly reference historical context alongside new motions.
**How to avoid:** Explicit prompt instruction: "Only extract NEW decisions made in THIS meeting. A decision requires an explicit motion or vote." Add a `confidence` field to the Zod schema so low-confidence extractions can be flagged for review. Post-extraction: grep the source transcript for each extracted dollar amount to verify it exists. ([arXiv:2511.10659](https://arxiv.org/abs/2511.10659)) 🔗
**Warning signs:** Extracted decision count seems implausibly high; amounts don't appear in a text search of the source.

### 🪤 Pitfall: YouTube Transcript IP Blocking
**What goes wrong:** YouTube blocks requests from IPs that make too many transcript extraction calls, returning `VideoUnavailable` errors.
**Why it happens:** YouTube rate-limits InnerTube API usage, especially from datacenter IPs. Users report limits around ~250 requests.
**How to avoid:** Rate-limit requests (add 2-5 second delays between calls). Run extraction locally (residential IP), not from Railway. For the backfill (~100-130 videos), spread over multiple sessions. ([youtube-transcript-api GitHub issues](https://github.com/jdepoix/youtube-transcript-api/issues)) 🔗
**Warning signs:** Intermittent `VideoUnavailable` errors for videos that are publicly accessible in a browser.

### 🪤 Pitfall: eGov Crawl Delay
**What goes wrong:** Aggressively scraping the eGov portal triggers rate limiting or IP blocking.
**Why it happens:** `robots.txt` specifies `Crawl-delay: 300` (5 minutes between requests).
**How to avoid:** Respect the crawl delay. For 1,450 documents, the full backfill would take ~5 days at 5-min intervals. Optimize by filtering to only Agendas (279) and Minutes (869) — still ~4 days. Consider scraping metadata first (title, date, type, ID from listing pages) at a faster rate, then downloading only the PDFs you need. 🔗 [robots.txt at ellettsville.in.us](https://ellettsville.in.us/robots.txt)
**Warning signs:** HTTP 429 or connection refused errors.

### 🪤 Pitfall: Whisper Hallucination on Silence
**What goes wrong:** Whisper generates phantom text during silent periods or background noise (HVAC, paper shuffling).
**Why it happens:** Whisper was trained to always produce output; it "fills in" silence with plausible but fabricated text.
**How to avoid:** Use `--no-speech-threshold 0.6` and VAD (Voice Activity Detection) preprocessing. whisper.cpp has a built-in `--vad` flag. Use `medium` or larger models which hallucinate less. Preprocess audio: normalize to 16kHz mono WAV, apply noise reduction via ffmpeg. 🔗 [whisper.cpp README](https://github.com/ggergml/whisper.cpp)
**Warning signs:** Repeated phrases in transcript; text appearing during known silence gaps (e.g., between agenda items).

### 🪤 Pitfall: Railway Volume Not Available During Build
**What goes wrong:** Database migrations fail during `vite build` because the Railway volume isn't mounted until container startup.
**Why it happens:** Railway volumes mount at runtime, not build time.
**How to avoid:** Run migrations in your start command, not your build command: `"start": "pnpm db:migrate && node .output/server/index.mjs"`. ([Railway Volume docs](https://docs.railway.com/guides/volumes)) 🔗
**Warning signs:** Build succeeds but app crashes on startup with "database not found" errors.

## Options Evaluated

### Data Source: YouTube Transcripts

#### Option A: youtube-transcript npm package (captions available)
- **Fits constraints:** 🔒 TypeScript, integrates with Effect via `Effect.tryPromise()`
- **Pros:** Free, instant, timestamped segments, native TypeScript
- **Cons:** Only works when captions exist; reliability issues at scale (IP blocking)
- **Docs:** 🔗 [npm](https://www.npmjs.com/package/youtube-transcript)

#### Option B: yt-dlp + whisper.cpp (no captions)
- **Fits constraints:** 🔒 Local processing on M1, free
- **Pros:** Works for any video regardless of caption availability; high-quality transcription
- **Cons:** Slow (15-30 min per 90-min meeting); YouTube TOS technically prohibits downloading; requires ffmpeg + whisper.cpp setup
- **Docs:** 🔗 [yt-dlp](https://github.com/yt-dlp/yt-dlp), [whisper.cpp](https://github.com/ggergml/whisper.cpp)

#### 💡 Recommended: Hybrid approach
Check for captions via YouTube Data API → extract with `youtube-transcript` if available → fall back to yt-dlp + Whisper if not. Model as an Effect service with two implementations behind a common `TranscriptionService` interface.

---

### Whisper Model Size

#### Option A: medium (769M params)
- **Pros:** Good accuracy (4-5% WER), 15-30 min for 90-min meeting on M1, fits in 8GB RAM
- **Cons:** Slightly less accurate on proper nouns and jargon than large models

#### Option B: large-v3-turbo (809M params)
- **Pros:** Near-large-v3 accuracy (3.5-4.5% WER), similar speed to medium (18-30 min)
- **Cons:** Slightly more RAM pressure on 8GB M1

#### 💡 Recommended: Start with `medium`, upgrade to `large-v3-turbo` if quality is insufficient
Both process at comparable speeds. The `initial_prompt` feature (pre-loading meeting-specific vocabulary) is more impactful than model size for this use case.

---

### LLM Provider for Summarization

#### Option A: Gemini 2.5 Flash
- **Fits constraints:** 🔒 Cheap, async processing
- **Pros:** $0.012/meeting, 1M token context window, free tier available for prototyping, official Vercel AI SDK provider
- **Cons:** Quality may be lower than Pro for complex fiscal extraction
- **Docs:** 🔗 [Gemini pricing](https://ai.google.dev/pricing), [@ai-sdk/google](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)

#### Option B: Kimi K2.5
- **Fits constraints:** 🔒 Cheap, async processing
- **Pros:** $0.013/meeting, 256K context window, official Vercel AI SDK provider (`@ai-sdk/moonshotai`)
- **Cons:** Newer provider, less community validation; API reliability unknown
- **Docs:** 🔗 [Moonshot provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai)

#### 💡 Recommended: Start with Gemini 2.5 Flash, keep Kimi K2.5 as fallback
Gemini has a free tier for prototyping, a larger context window, and more community validation. Vercel AI SDK makes swapping trivial — change one line. Use both during development to compare quality on the same transcripts.

---

### Effect + Vercel AI SDK Integration

#### Option A: Use @effect/ai packages directly
- **Pros:** Native Effect integration, ExecutionPlan for multi-provider fallback
- **Cons:** Doesn't have Gemini or Moonshot providers yet (only OpenAI and Anthropic); duplicates the model abstraction Vercel AI SDK already provides

#### Option B: Wrap Vercel AI SDK in Effect services
- **Pros:** Uses the user's chosen abstraction (Vercel AI SDK) for model swapping; 30+ providers available; `Output.object()` with Zod for structured extraction
- **Cons:** Requires `Effect.tryPromise()` boundary wrapping; two abstraction layers (Effect + AI SDK)

#### 💡 Recommended: Option B — Wrap Vercel AI SDK in Effect
The user explicitly chose Vercel AI SDK for provider swapping. Wrapping `generateText()` in `Effect.tryPromise()` is straightforward. Define an `LlmService` via `Context.Tag` that internally uses the AI SDK.

## 💡 Recommended Approach

### Pipeline Architecture (Effect Services)

```
Pipeline Entry (NodeRuntime.runMain)
  │
  ├── ScraperService
  │     ├── EgovScraper      — HTML parse + PDF download
  │     ├── FinalsiteScraper — Single page parse + PDF download
  │     └── YouTubeScraper   — Data API v3 playlist listing
  │
  ├── TranscriptionService
  │     ├── YouTubeCaptionProvider  — youtube-transcript package
  │     └── WhisperLocalProvider    — whisper.cpp child process
  │
  ├── SummarizationService
  │     └── VercelAiProvider — generateText + Output.object w/ Zod schema
  │           ├── MeetingSummarySchema
  │           └── FiscalExtractionSchema
  │
  ├── StorageService
  │     └── DrizzleSqliteProvider — @effect/sql-sqlite-node
  │
  └── AlertService
        └── ResendProvider — email on pipeline failure
```

Each service defines typed errors (`NetworkError`, `ParseError`, `TranscriptionError`, `LlmError`, `DatabaseError`). Cross-cutting concerns (retry, rate-limit, timeout) compose declaratively via `Effect.retry()` and `Schedule`.

### Data Source Details

**eGov Portal:**
- URL: `https://ellettsville.in.us/egov/apps/document/center.egov?view=browse`
- Pagination: `?app=4&sect=content&page=4_{N}&eGov_searchType={11|12|19}` (Agendas=11, Minutes=12, Ordinances=19)
- PDF download: `?view=item&id={N}` → 302 redirect to PDF
- Total relevant docs: ~1,148 (Agendas: 279, Minutes: 869)
- ⚠️ Crawl delay: 300 seconds between requests

**Finalsite (RBB School Board):**
- URL: `https://www.rbbschools.net/school-board`
- Structure: Server-rendered accordion panels by year, HTML tables with date/type/links
- PDFs: `/fs/resource-manager/view/{UUID}` → 302 redirect to CDN
- No auth, no JS rendering needed

**CATS YouTube:**
- Channel: `@communityaccesstelevisions9400`
- Relevant playlists: Ellettsville Town Council (146), Plan Commission (55), Parks & Rec (4), BZA (3), Redevelopment Commission (17), Monroe County Commissioners (405), Monroe County Council (219)
- Title format: `[Body], [Month Day, Year]`
- ⚠️ Captions inconsistently available — check via `videos.list` `contentDetails.caption` field
- Quota: ~21 units for 500 videos (well within 10K daily limit)

### Transcription Strategy

1. YouTube Data API: list all videos in target playlists, check `contentDetails.caption`
2. If `caption == "true"`: use `youtube-transcript` npm package (free, instant, timestamped)
3. If `caption == "false"`: download audio via yt-dlp, transcribe with whisper.cpp (medium model, Core ML, `--output-json` for timestamps)
4. Use `initial_prompt` with meeting-specific vocabulary (board member names, street names, ordinance numbers)
5. Preprocess audio: normalize to 16kHz mono WAV, noise reduction via ffmpeg

### Summarization & Fiscal Extraction

- **Provider:** Gemini 2.5 Flash via `@ai-sdk/google`, swappable to Kimi K2.5 via `@ai-sdk/moonshotai`
- **Method:** `generateText()` + `Output.object()` with Zod schema
- **No chunking needed:** 15K-word transcript = ~20K tokens, well within Gemini's 1M context window
- **Cost:** ~$0.012/meeting (Gemini Flash), ~$0.013/meeting (Kimi K2.5)
- **Two-pass approach:** Pass 1 extracts structured data; Pass 2 validates extracted amounts exist in source text
- **Schema:** Detailed Zod schema with `FiscalDecision` type including amount, vendor, budget category, vote record, confidence level, and `budgetDiscussionsWithoutAction` for upcoming items

### Deployment

- **Railway** (official TanStack Start partner): `node .output/server/index.mjs`
- **SQLite Volume:** Mount at `/app/data`, set `DATABASE_URL=/app/data/civic-mirror.db`
- **Migrations:** Run in start command, not build: `pnpm db:migrate && node .output/server/index.mjs`
- **Email alerts:** Resend (3K/month free)
- **Cost:** ~$5-7/month on Hobby plan

## Relevant Existing Code

- `src/db/schema.ts` — Current Drizzle schema (only has a `todos` table — will need complete redesign for meetings, transcripts, summaries, fiscal_decisions tables)
- `src/db/index.ts` — Database client setup (reusable, but may need to be wrapped in an Effect Layer)
- `drizzle.config.ts` — Points to SQLite at `DATABASE_URL` env var (production will use Railway volume path)
- `vite.config.ts` — TanStack Start + Vite config (no changes needed for pipeline; pipeline runs as separate CLI script)
- `src/router.tsx` — TanStack Router with Query integration (will add new routes for meeting pages, dashboard)

## Assumption Status Update

| Original Tag | Assumption | Updated Tag | Finding |
|---|---|---|---|
| `Speculative` | LLM can reliably extract structured fiscal data | `Likely` | Academic research shows 84%+ accuracy on harder problems. Two-pass verify approach + confidence field mitigates remaining risk. |
| `Uncertain` | Caption availability on CATS videos | `Established` | Inconsistent. Some videos have captions, many don't. Hybrid caption+Whisper approach handles both cases. |
| `Uncertain` | eGov portal structure stability | `Established` | Legacy CORE Business Technologies CMS, MooTools 1.6, version-stable code. Structural redesign risk is low. |
| `Uncertain` | Effect learning curve impact | `Likely` | 1-2 week ramp-up on core patterns. Published pipeline article exists as reference. Service pattern maps directly to this architecture. |
| `Likely` | Gemini/Kimi quality for summarization | `Established` | Both have official Vercel AI SDK providers. Cost is ~$0.01/meeting. Context windows handle full transcripts in single calls. |
| `Likely` | Whisper quality on meeting audio | `Likely` | medium/large-v3-turbo recommended. Known issues with silence hallucination and proper nouns mitigated by `initial_prompt`, VAD, and audio preprocessing. Final quality needs empirical validation on actual CATS recordings. |

## 🔗 Sources

**✅ Verified (official docs, matches installed/target version):**
- [Effect documentation — Introduction](https://effect.website/docs/getting-started/introduction) — Effect 3.x core patterns
- [Effect documentation — HTTP Client](https://effect.website/docs/platform/http-client) — @effect/platform HTTP
- [Effect documentation — Layers](https://effect.website/docs/requirements-management/layers) — Service/Layer pattern
- [AI SDK — Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) — Output.object() with Zod
- [AI SDK — Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai) — @ai-sdk/google v3.x
- [AI SDK — Moonshot Provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai) — @ai-sdk/moonshotai v2.x
- [Gemini Pricing](https://ai.google.dev/pricing) — $0.30/M input, $2.50/M output for Flash
- [YouTube Data API — playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list) — Quota and pagination
- [TanStack Start — Hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting) — Railway as official partner
- [Railway — Volumes](https://docs.railway.com/guides/volumes) — Persistent storage for SQLite
- [whisper.cpp GitHub](https://github.com/ggergml/whisper.cpp) — M1 Core ML support, model sizes
- [youtube-transcript npm](https://www.npmjs.com/package/youtube-transcript) — v1.3.0, TypeScript native
- [Resend docs](https://resend.com/docs) — Email API, 3K/month free tier

**⚠️ Partially verified (community source, or version not exactly matched):**
- [Building a Fault-Tolerant Web Data Ingestion Pipeline with Effect-TS](https://dev.to/prithwish_nath/building-a-fault-tolerant-web-data-ingestion-pipeline-with-effect-ts-29l1) — Published Jan 2026, uses Effect 3.x patterns
- [Information Extraction From Fiscal Documents Using LLMs (arXiv:2511.10659)](https://arxiv.org/abs/2511.10659) — Academic paper, Gemini 2.5 Pro (not Flash)
- [Vercel Academy — Structured Data Extraction](https://vercel.com/academy/ai-sdk/structured-data-extraction) — AI SDK 6 patterns
- [Why We Love FP but Don't Use Effect-TS (Harbor)](https://runharbor.com/blog/2025-11-24-why-we-dont-use-effect-ts) — Ecosystem isolation concerns

**❓ Unverified (blog post, may be outdated, or no doc link found):**
- Kimi K2.5 pricing ($0.38/M input, $1.72/M output) — sourced from OpenRouter, direct Moonshot pricing page not available in English
- CATS YouTube caption availability percentage — could not determine ratio without checking each video individually
