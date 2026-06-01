# Influencer Tool — At a Glance

## What this tool does, in one paragraph

You search hashtags or keywords across Instagram, TikTok, YouTube, and X. The tool fetches profile data from those platforms, filters them by your rules (followers, location, language, food-focus, etc.), and uses AI to classify each creator into a tier and type. You save the keepers, track who you've contacted, and compare discoveries against a manual baseline.

---

## The flow

```
  Search ──► Filter ──► Enrich ──► Classify ──► Save ──► Outreach
 (per-platform   (your        (AI: 6        (AI: tier    (Supabase)   (pipeline
   backend)      rules)       narrative     + type)                   tracking)
                              fields)
```

The same flow runs against two parallel datasets — see [Datasets](#datasets) below.

---

## Where the data comes from — per platform

Each platform uses a different backend, because each one fights scraping differently.

### 📸 Instagram

| | |
|---|---|
| **Search / discovery** | **Apify** (`apify/instagram-scraper`, hashtag mode) |
| **Live profile lookup** | BrightData Web Unlocker |
| **What it needs** | `APIFY_API_TOKEN` |
| **Account rotation** | **Retired** — the multi-account session-cookie pool is gone; Apify handles proxies internally |
| **Notes** | Discovery no longer fetches follower counts (filled later by enrich/verify). No cookies to manage. |

### 🎵 TikTok

| | |
|---|---|
| **Search / discovery** | Three possible backends, in order of preference: 1) **Apify** (the `clockworks/tiktok-scraper` actor — most reliable), 2) **TikTok Research API** (official, if you have developer credentials), 3) **BrightData residential proxy** (fallback) |
| **Live profile lookup** | Same fallback chain |
| **What it needs** | At least one of: `APIFY_API_TOKEN`, or `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET`, or BrightData proxy |
| **Account rotation** | Optional TikTok session cookie for logged-in scraping |
| **Notes** | Apify costs per call but is the cleanest path. The Research API is free but requires approval from TikTok. |

### ▶️ YouTube

| | |
|---|---|
| **Search / discovery** | Direct fetch from `youtube.com/@handle` — no proxy, no API key |
| **Live profile lookup** | Same — direct fetch, parses YouTube's embedded JSON |
| **Post enrichment** | Official **YouTube Data API v3** (`YOUTUBE_API_KEY`) — recent videos with views/likes/comments. Free (quota-based). |
| **What it needs** | Nothing for discovery; `YOUTUBE_API_KEY` for post enrichment. |
| **Account rotation** | N/A |
| **Notes** | Cheapest platform. Shorts are regular uploads, so they're captured automatically (flagged `is_short` by duration). |

### 𝕏 X (Twitter)

| | |
|---|---|
| **Search / discovery** | **Apify** (`apidojo/tweet-scraper`) |
| **Live profile lookup** | BrightData Web Unlocker → X's internal GraphQL endpoint |
| **Post enrichment** | **Apify** (`kaitoeasyapi/...cheapest`) — recent tweets with likes/replies/views/bookmarks |
| **What it needs** | `APIFY_API_TOKEN` (discovery + enrichment); BrightData for live lookup |
| **Account rotation** | **Retired** — the X cookie pool is gone; Apify handles it |
| **Notes** | Cheapest engagement data of the paid platforms. |
| **Cross-platform discovery** | All four platforms above are also used in reverse: given a creator on one network, the tool looks up candidate handles on the others and confirms identity. This powers the "find other platforms" button in the Results tab. |

---

## Post enrichment — recent ~30 posts per creator

A separate step pulls each creator's recent ~30 posts/videos **with per-post engagement** and stores them in the `profile_posts` table. To keep it cheap, it enriches **one platform per person** — whichever platform they have the most followers on — deduped across all discovery tables.

| Platform | Source | Likes | Comments | Views | Saves | Shares |
|---|---|---|---|---|---|---|
| Instagram | Apify | ✓ | ✓ | videos only | — | — |
| TikTok | Apify | ✓ | ✓ | ✓ | ✓ | ✓ |
| X | Apify | ✓ | ✓ (replies) | ✓ | ✓ (bookmarks) | ✓ (rt+quotes) |
| YouTube | **YouTube Data API (free)** | ✓ | ✓ | ✓ | — | — |

- **YouTube Shorts** are captured automatically (they're regular uploads) and flagged `is_short` by duration, so they can be separated from long-form (their engagement profiles differ a lot).
- Run via `node scripts/enrich-posts-batch.mjs` — resumable, won't re-charge handles already done. Roughly **$0.10/profile** across the paid platforms; YouTube is free.

---

## What the AI does

Three separate AI-powered features:

| Feature | What it does | Default model | Uses web search? |
|---|---|---|---|
| **Enrich** | Generates 6 narrative fields per creator (who they are, what they post, tone, audience, why follow, content labels). Runs per profile after discovery. | Claude Sonnet 4.6 | Yes — Anthropic `web_search_20250305`, up to 4 uses per profile |
| **Classify** | Decides each creator's tier (T1–T4) and type (Chef / Food Reviewer / Lifestyle Blogger / etc.) | Claude Haiku 4.5 | No |

You can swap providers in the UI — Anthropic, OpenAI, Gemini, and xAI Grok are all wired up. Anthropic is the default.

### About the legacy Claude-search flow

The codebase still contains a legacy "find creators via Claude + web search" path: the `/api/search` endpoint, the `runLiveSearch()` / `openImportModal()` JS functions, and the old sidebar UI with sources lists and keyword combinations. **It is not reachable from the UI.** The container that held it (`mainDash`) is hidden, and `switchMainTab()` actively redirects any attempt to open it back to the Overview tab. The only live discovery path today is the **Search & Enrich tab** (BrightData / Apify / direct platform fetch).

This dead code could be removed as a cleanup task — see SYSTEM_FLOW.md for the file/line pointers.

### How tiers are decided

Food-focus is a gate, not a level. **Anyone not food-focused becomes T4**, regardless of follower count. Food-focused creators are then ranked by size and engagement rate (ER):

| Tier | Criteria (all must hold) |
|---|---|
| **T1** | Food-focused, 100K+ followers, UK-based, ER ≥ 2%, posting recently, active on 2+ platforms |
| **T2** | Food-focused, 25K–100K followers, ER ≥ 3% |
| **T3** | Food-focused, 10K–25K followers (micro-influencer range) |
| **T4** | Not food-focused — kept in the DB but flagged as off-topic |

Tiers combine real numbers (followers, ER) with AI-determined booleans (`food_focus`, `uk_based`, `active_recently`).

### Creator types

Chef · Home Cook & Recipe Creator · Food Reviewer · Food Guide & Curator · Mukbanger · Street Food & Market Explorer · Cuisine Specialist · Drinks & Nightlife · Travel Blogger · Lifestyle Blogger · City Guide / Editorial

---

## Datasets

The tool runs two parallel datasets with the same schema and UI, switchable in the Results tab:

- **Food** — the original. Tables: `influencers`, `brightdata_profiles`, `brightdata_excluded_profiles`.
- **Lifestyle** — separate filter rules, separate tables: `lifestyle_bloggers`, `lifestyle_bloggers_excluded`.

The Overview tab merges both into a unified dashboard.

---

## Where data is stored

Everything lives in **Supabase** (Postgres + REST API). Grouped by purpose:

**Profile data**
| Table | What's in it |
|---|---|
| `influencers` | Curated main list (the "Results" tab in the older flow) |
| `brightdata_profiles` | Food-dataset search results that passed the filter |
| `brightdata_excluded_profiles` | Food-dataset results that were filtered out (kept for review) |
| `lifestyle_bloggers` | Lifestyle-dataset equivalent of `brightdata_profiles` |
| `lifestyle_bloggers_excluded` | Lifestyle equivalent of the excluded table |
| `profile_posts` | Recent ~30 posts/videos per creator with per-post engagement (one row per post, with `is_short` flag) |

**Workflow**
| Table | What's in it |
|---|---|
| `manual_influencers` | Manually-imported baseline list (used by the Coverage tab) |
| `outreach` | Contact pipeline — who's been messaged, who responded, deal terms |
| `banned_influencers` | Blacklisted handles |

**Operational**
| Table | What's in it |
|---|---|
| `influencer_snapshots` | Change log — what changed and when |
| `platform_sessions` | Saved session cookies for IG / TT / X |
| `search_run_logs` | History of every search run and what it found |

---

## Local persistence (in your browser)

Stored in localStorage instead of the DB. Grouped by what breaks if it's wiped:

**Auth & credentials (tool stops working)**
- App password
- TikTok session cookie (Instagram & X cookie pools are retired — those platforms now use Apify)

**User preferences (UX resets to defaults)**
- Last-opened tab
- Default search keywords list
- Filter group state

**Performance cache (no data loss, just a re-fetch)**
- Chunked cache of last search results
- Tier/type labels per profile (mirrored to DB, so safe)

---

## Required setup (the minimum to make it work)

| You need… | …or you can't… |
|---|---|
| Supabase URL + service key | …store or load anything |
| Anthropic API key | …run the default Search / Enrich / Classify flows |
| `APIFY_API_TOKEN` | …search Instagram / TikTok / X, and run post enrichment for them |
| BrightData token | …live-verify follower counts for Instagram / X |
| `YOUTUBE_API_KEY` | …run YouTube post enrichment (recent videos) |

YouTube discovery needs no extra config. TikTok can also use its Research API credentials as an alternative to Apify.

The `APP_PASSWORD` env var is optional — it adds a simple shared-secret check on the API. If you don't set it, the API is open.

---

## The 5 tabs at a glance

| Tab | What you do here | Touches |
|---|---|---|
| **Overview** | Unified dashboard merging Food + Lifestyle — stat cards, source split (food-only / lifestyle-only / both), configurable cross-tab heat map (tier × type, tier × follower bucket, etc.) | All profile tables |
| **Search & Enrich** | Run a new search on one platform (platform-appropriate backend), watch live progress, filter raw results, save keepers | `brightdata_profiles` / `lifestyle_bloggers`, Search + Enrich AI |
| **Results** | Browse saved profiles — switch between Food/Lifestyle, between matching/filtered-out views, run AI classification, change tiers/types | All profile tables, Classify AI |
| **Outreach** | Track contact pipeline — dates, prices, deal terms | `outreach` |
| **Coverage** | Compare manual baseline against BD discoveries — flag anyone missing | `manual_influencers` vs `brightdata_profiles` |

---

## What costs money

- **Anthropic / OpenAI / Gemini / Grok** — every Search, Enrich, and Classify call is paid LLM usage. Classify is the cheapest (Haiku, 50-row batches).
- **Apify** — pay-per-result for Instagram / TikTok / X discovery **and** post enrichment. Post enrichment is ~$0.10/profile across the paid platforms (≈$220 to enrich the full ~12.5k creator set, one platform each).
- **BrightData** — pay-per-request for the Web Unlocker, now only for live follower verification (IG and X).
- **Supabase** — flat plan, no per-row charge unless you exceed storage limits.

YouTube is free end-to-end — discovery, live lookup, and post enrichment (Data API, quota-based) all cost nothing.
