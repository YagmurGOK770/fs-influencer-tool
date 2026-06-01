# Influencer Tool — System Specification

This is a grounded, code-based spec of how the tool actually works. Every claim cites a file and line so you can verify it. Anything I couldn't ground is marked `(verify)` or omitted. Line numbers reference the state of the code at the time of writing — they may drift one or two lines as the file changes.

---

## 1. Top-level Navigation / Tabs

The single-page app has 5 top-level tabs, all wired through [switchMainTab()](influencer-tool/public/index.html#L2496) in [influencer-tool/public/index.html:2496](influencer-tool/public/index.html#L2496).

| Tab button | Label | Container div | Loader function |
|---|---|---|---|
| `tabInsightsBtn` | Overview | `mainInsights` | `bdrEnsureBothDatasetsLoaded()` → `bdrInsightsRender()` |
| `tabEnrichBtn` | Search & Enrich | `mainEnrich` | `loadEnrichTab()` |
| `tabBdResultsBtn` | Results | `mainBdResults` | `bdrUpdateModelSel()` + `loadBdResults()` |
| `tabOutreachBtn` | Outreach | `mainOutreach` | `loadOutreach()` |
| `tabCoverageBtn` | Coverage | `mainCoverage` | `loadCoverage()` |

Defined at [index.html:354-358](influencer-tool/public/index.html#L354-L358). Last-opened tab is persisted via `localStorage.activeMainTab` ([index.html:2518](influencer-tool/public/index.html#L2518)) and restored at boot ([index.html:3099](influencer-tool/public/index.html#L3099)).

### 1.1 Overview (`mainInsights`)

Aggregates BOTH food + lifestyle datasets into a unified view.

- On open: `bdrEnsureBothDatasetsLoaded()` lazy-fetches whichever dataset isn't already cached, then `bdrInsightsRender()` renders ([index.html:6914-6933](influencer-tool/public/index.html#L6914-L6933)).
- Source determination: A creator's "source" (food / lifestyle / both) is computed from matching tables only — excluded-only profiles are filtered out of Overview ([index.html:6950-6968](influencer-tool/public/index.html#L6950-L6968)).
- **Stat cards** ([index.html:7063-7069](influencer-tool/public/index.html#L7063-L7069)): Unique creators, total followers, avg ER%, T1 creator count, typed-creator count.
- **Source split cards** ([index.html:7076-7085](influencer-tool/public/index.html#L7076-L7085)): Food-only, Lifestyle-only, In-both.
- **Platform pills** (`insPcAll/Ig/Tt/Yt/X`) — counts derived from merged set ([index.html:7034-7038](influencer-tool/public/index.html#L7034-L7038)).
- **Cross-tab heat map**: configurable row dim × col dim × metric. Dims: `tier`, `type`, `followers`, `er`. Metrics: `count`, `followers`, `er` ([index.html:7048-7050, 7087-7172](influencer-tool/public/index.html#L7048-L7172)).
- Follower buckets: `1M+`, `500K–1M`, `100K–500K`, `50K–100K`, `10K–50K`, `<10K`, `Unknown` ([index.html:6978-6988](influencer-tool/public/index.html#L6978-L6988)).
- ER buckets: `10%+`, `5–10%`, `3–5%`, `1–3%`, `<1%`, `Unknown` ([index.html:6990-6999](influencer-tool/public/index.html#L6990-L6999)).
- For YouTube creators, ER is recomputed as `avg_likes / followers × 100` rather than using `engagement_rate` ([index.html:7054-7058](influencer-tool/public/index.html#L7054-L7058)).

### 1.2 Search & Enrich (`mainEnrich`)

The workspace where you run BrightData searches per platform, filter the raw results, and save the keepers to the DB. Tab loader: [loadEnrichTab() at index.html:4592](influencer-tool/public/index.html#L4592). After perf fix, this only runs once per session and is gated by `_enrichTabLoaded`.

Wires the following state from localStorage on first open ([index.html:4593-4679](influencer-tool/public/index.html#L4593-L4679)):
- Instagram cookie pool (`bd_cookie_pool`), with legacy fallback to `bd_session_cookie`
- TikTok session cookie (`tt_session_cookie`)
- X cookie pool (`x_cookie_pool`), with legacy fallback to `x_session_cookie`
- Filter group state (`bd_filter_state`) — new format `{ topMode, groups[] }` or legacy `{ mode, rules[] }`
- Cached search results — chunked under `bd_cached_results_meta` + `bd_cached_results_chunk_{i}` ([index.html:4653-4677](influencer-tool/public/index.html#L4653-L4677))

**Key UI inside the tab**:
- **Platform selector** (`bdPlatformSel`): instagram | tiktok | youtube | x — drives `bdOnPlatformChange()`. The Instagram/X **cookie-pool UI is removed** (multi-account retired; IG discovery is on Apify, X on Apify). Only the single TikTok session cookie remains. The "Re-enrich missing" button was also removed; "Scan recent posts" now works for every platform.
- **Hashtag / keyword input** (`bdKeyword`): comma-separated.
- **Saved-search dropdown** with Save/Delete (server-backed presets).
- **Filter Builder** (`bdFilterGroups`): multi-group, AND/OR within and between groups. Fields available include `bio`, `name`, `location`, `followers`, `avgLikes`, `avgComments`, `engagementRate`, `postContent`, `postLocation`, `hashtagPosts`, `verified`, `ukBased`, `foodFocus`, `language` ([index.html:4890-5000+](influencer-tool/public/index.html#L4890)).
- **Search button** triggers a multi-keyword run, calling `/api/verify` with `{ action: 'bd-search', ... }` and polling progress via `bd-search-status`.
- **Results table** (`bdTbody`) — after recent perf fix, renders the first 100 rows immediately then streams more via `requestAnimationFrame` in 200-row batches ([index.html:5598-5634](influencer-tool/public/index.html#L5598-L5634)).
- **View toggle** Matching ↔ Filtered-out ([index.html:5278-5313](influencer-tool/public/index.html#L5278-L5313)).
- **Save buttons**:
  - `💾 Save filtered results to DB` → `bdSaveFiltered()` — writes to the active dataset's matching table.
  - `💾 Save to review table` (excluded view) → writes to the excluded table.
  - `💾 Save all to LifestyleBloggers` → writes everything to `lifestyle_bloggers`.
  - `📂 Import JSON`, `⬇ Export JSON` for backup/restore.

### 1.3 Results — BD Results (`mainBdResults`)

Browses what's been saved to the DB across both datasets. Loader: [loadBdResults() at index.html:6801](influencer-tool/public/index.html#L6801). Calls `/api/db-save` with `action: 'brightdata-load'` and `dataset: 'food'|'lifestyle'` ([index.html:6807-6816](influencer-tool/public/index.html#L6807-L6816)).

- **Dataset switcher**: `bdrSetDataset('food'|'lifestyle')` — cached in `_bdrDatasetCache` so switching is instant after first fetch ([index.html:7820-7849](influencer-tool/public/index.html#L7820-L7849)).
- **View modes**: `matching` vs `excluded` (`bdrSetView`) ([index.html:7807-7817](influencer-tool/public/index.html#L7807-L7817)).
- **Platform pill filter** (`bdrSetPlatform`): all/ig/tt/yt/x.
- **Per-row attributes**: tier (T1–T4), type (creator category), language, UK-based, food-focus, relevancy override.
- **Active filters**: tier dropdown, type dropdown, language dropdown, free-text search ([index.html:7917-7997](influencer-tool/public/index.html#L7917-L7997)).
- **Re-classification banner**: when filter rules in the Enrich tab change which profiles "pass", a banner shows movement counts and a "Save to DB" button ([index.html:6712-6753](influencer-tool/public/index.html#L6712-L6753)).
- **Per-handle merge**: `bdrMergeByHandle()` deduplicates platform rows for the same creator and aggregates captions/locations/keywords ([index.html:6599-6702](influencer-tool/public/index.html#L6599-L6702)). Recently fixed cache (was dead code).
- **Pagination**: 100 rows/page (`BDR_PAGE_SIZE`) via `bdrRenderPage` ([index.html:8040-8059](influencer-tool/public/index.html#L8040-L8059)).
- **AI Classify**: classifies visible rows in batches of 50 via `/api/classify` ([index.html:6506-6593](influencer-tool/public/index.html#L6506-L6593)).

### 1.4 Outreach (`mainOutreach`)

Pipeline for tracking who's been contacted. Loader: [loadOutreach() at index.html:8564](influencer-tool/public/index.html#L8564). Backed by the `outreach` table via `/api/db-save?action=outreach-list|save|delete`.

Form fields (from the add/edit modal): handle, email, mobile, agency-required flag, contacted date, responded flag + date, price range (min/max), deal terms, notes ([index.html:4286-4341](influencer-tool/public/index.html#L4286-L4341)).

### 1.5 Coverage (`mainCoverage`)

Compares a manually-imported baseline list against what BD Results has discovered. Loader: [loadCoverage() at index.html:3313](influencer-tool/public/index.html#L3313).

- Calls `/api/db-save?action=manual-coverage` ([index.html:3319-3324](influencer-tool/public/index.html#L3319-L3324)).
- Stats cards: total manual, total BD, matched, manual-only, BD-only ([index.html:3334-3343](influencer-tool/public/index.html#L3334-L3343)).
- Filters: All / Found in BD / Missing from BD.
- Import paths: CSV paste or `.xlsx`/`.csv` upload (`handleCovFile`).
- Backing table: `manual_influencers` (written by `/api/manual-import`).

---

## 2. Per-Platform Support

The tool treats four platforms as first-class: **Instagram**, **TikTok**, **YouTube**, **X (Twitter)**. Each goes through a different mechanism end-to-end.

### 2.1 Search / Discovery

| Platform | Backend in `/api/verify.js` | External service |
|---|---|---|
| Instagram | `igHashtagSearch()` ([verify.js:479](influencer-tool/api/verify.js#L479)) | **Apify** (`apify/instagram-scraper`, hashtag mode). The multi-account cookie pool is **retired**. Follower counts are not fetched at discovery (filled later by enrich/verify). |
| TikTok | `verifyTikTokBatch()` ([verify.js:121](influencer-tool/api/verify.js#L121)) for batch, `verifyTikTok()` ([verify.js:193](influencer-tool/api/verify.js#L193)) per-profile | Apify (`clockworks/tiktok-scraper`), TikTok Research API (if `TIKTOK_CLIENT_KEY`+`SECRET` set, [verify.js:962-973](influencer-tool/api/verify.js#L962-L973)), or direct scrape via BrightData residential proxy |
| YouTube | `verifyYouTube()` ([verify.js:283](influencer-tool/api/verify.js#L283)) | Direct fetch of channel page HTML (no proxy needed). Parses `ytInitialData` |
| X | `verifyX()` ([verify.js:323](influencer-tool/api/verify.js#L323)) | BrightData Web Unlocker against GraphQL endpoint `/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName` ([verify.js:341](influencer-tool/api/verify.js#L341)) |

The "find other platforms" cross-platform discovery is a separate action (`find-other-platforms` in [db-save.js:1266](influencer-tool/api/db-save.js#L1266)) that fans out from a known handle to look for the same person on the other 3 platforms.

There is also a Claude-powered web-search discovery in [`/api/search.js`](influencer-tool/api/search.js) (the original v1 search) that returns candidate profiles via the Anthropic `web_search` tool — used by the older Search tab flow / sidebar inputs.

### 2.2 Live Verification (follower counts, bio, verified badge)

`/api/verify` is the per-handle live-fetch endpoint. Dispatches per platform:

| Platform | Method | Output fields |
|---|---|---|
| Instagram | BrightData Web Unlocker → web profile JSON ([verify.js:77-107](influencer-tool/api/verify.js#L77-L107)) | `followers`, `bio`, `fullName`, `isPrivate`, `isVerified`, `postCount` |
| TikTok | Residential proxy or Apify; parses `__UNIVERSAL_DATA_FOR_REHYDRATION__` / `__NEXT_DATA__` ([verify.js:233-255](influencer-tool/api/verify.js#L233-L255)) | Same |
| YouTube | Direct fetch, parses `subscriberCountText` ([verify.js:306-309](influencer-tool/api/verify.js#L306-L309)) | `followers`, `bio`, `fullName`, `isVerified`, `postCount`, `country` |
| X | BrightData Web Unlocker → GraphQL `UserByScreenName` ([verify.js:323-368](influencer-tool/api/verify.js#L323-L368)) | `followers`, `bio`, `fullName`, `isPrivate`, `isVerified`, `postCount`, `location` |

### 2.3 Enrichment

`/api/enrich` calls Claude (`claude-sonnet-4-6` default, [enrich.js:7](influencer-tool/api/enrich.js#L7)) with web search enabled (max 4 uses, [enrich.js:9](influencer-tool/api/enrich.js#L9)) and returns 6 narrative fields: `whoTheyAre`, `whatTheyPost`, `toneStyle`, `targetAudience`, `whyFollow`, `contentLabels`. Platform-agnostic — same prompt regardless of platform.

### 2.4 Classification (Tier + Type)

`/api/classify` ([classify.js](influencer-tool/api/classify.js)) is platform-aware in only one place: it considers `platform_count` (how many platforms the same creator is on) as a tier signal ([classify.js:69-94](influencer-tool/api/classify.js#L69-L94)).

- **Creator types** (from prompt at [classify.js:1-90](influencer-tool/api/classify.js#L1-L90)): Chef, Home Cook & Recipe Creator, Food Reviewer, Food Guide & Curator, Mukbanger, Street Food & Market Explorer, Cuisine Specialist, Drinks & Nightlife, Travel Blogger, Lifestyle Blogger, City Guide / Editorial.
- **Tier logic**: Combines numeric data (followers, ER) with LLM-emitted booleans `food_focus`, `uk_based`, `active_recently`.
  - **Tier 1**: 100K+, food_focus, uk_based, ER ≥ 2%, active_recently, 2+ platforms.
  - **Tier 2**: 25K–100K, food_focus, ER ≥ 3%.
  - **Tier 3**: 10K–25K (micro).
  - **Tier 4**: not food-focused (still kept, but tier-4).
- **Default classification model**: `claude-haiku-4-5-20251001` ([classify.js:176](influencer-tool/api/classify.js#L176)).
- **Concurrency**: 10 parallel classifications per request ([classify.js:209](influencer-tool/api/classify.js#L209)).
- **Supported providers**: anthropic | openai | gemini | grok ([classify.js:176](influencer-tool/api/classify.js#L176)).

### 2.4b Post enrichment — recent ~30 posts per profile

A separate enrichment step pulls each creator's recent ~30 posts/videos with per-post engagement and stores them in the `profile_posts` table (§4.11). Shared fetchers live in [api/post-enrich.js](influencer-tool/api/post-enrich.js) and are used by both the UI "Scan recent posts" button (`handleBdScanPosts` in [verify.js](influencer-tool/api/verify.js), action `bd-scan-posts`) and the bulk batch runner [scripts/enrich-posts-batch.mjs](influencer-tool/scripts/enrich-posts-batch.mjs).

| Platform | Source | Per-post fields captured |
|---|---|---|
| Instagram | Apify `apify/instagram-scraper` (`resultsType:'posts'`, limit 30) | likes, comments, views (video only), caption, hashtags, mentions, type, url, timestamp, location, tagged users. **No saves/shares** (IG doesn't expose them). |
| TikTok | Apify `clockworks/tiktok-scraper` (30) | likes, comments, views, **saves** (`collectCount`), **shares**, caption, hashtags, music, duration, location. |
| X | Apify `kaitoeasyapi/...cheapest` (one run per handle, capped to 30) | likes, replies, views, **bookmarks**(saves), retweets+quotes(shares), text, hashtags, mentions. Native retweets / foreign-author tweets are filtered out. |
| YouTube | **Official YouTube Data API v3** (free; uses `YOUTUBE_API_KEY`) — uploads playlist → `playlistItems` → `videos.list` | views, likes, comments, title, duration, publishedAt, thumbnail. |

- **One platform per person**: the batch runner dedupes by handle across all four discovery tables (incl. excluded) and enriches only the platform where the creator has the most followers ([enrich-posts-batch.mjs `buildPeople`](influencer-tool/scripts/enrich-posts-batch.mjs)).
- **YouTube Shorts** are regular uploads, so they're already captured. Each video post carries an `is_short` flag (heuristic: `duration_sec <= 180`) so Shorts can be separated from long-form (their engagement profile differs sharply).
- **Resumable / cost-safe**: skips handles already in `profile_posts` or recorded in the run's JSONL log (so 0-post/dead handles aren't re-charged); Apify GET reads retry with backoff while the actor-start POST never retries (no duplicate billed runs).
- Profile-level aggregates (`avg_likes/comments/views/saves/shares`, `engagement_rate`) are recomputed onto the source row from the fetched posts.

### 2.5 Frontend rendering per platform

**Profile URL builder** ([index.html:5707-5716](influencer-tool/public/index.html#L5707-L5716)):
```
instagram → https://www.instagram.com/{handle}/
tiktok    → https://www.tiktok.com/@{handle}
youtube   → https://www.youtube.com/@{handle}
x         → https://x.com/{handle}
```

**Platform classification** ([index.html:587-606](influencer-tool/public/index.html#L587-L606)):
```
includes('instagram') → 'ig'
includes('tik')       → 'tt'
includes('you')       → 'yt'
otherwise             → 'x'
```

**Compact follower parser** ([index.html:5687-5694](influencer-tool/public/index.html#L5687-L5694)): handles `342K`, `2.24M`, `1.5B`, `12,345`.

**Handle normalization**: lowercase + strip leading `@` ([verify.js stripAt](influencer-tool/api/verify.js#L73)). YouTube canonical form is `@handle` (channel IDs `UCxxx` are NOT treated as handles).

**Per-platform columns in the `influencers` table**: `ig_handle/ig_followers`, `tt_handle/tt_followers`, `yt_handle/yt_followers`, `x_handle/x_followers`, plus a consolidated `followers` field.

---

## 3. Configuration

### 3.1 Environment variables

| Var | Purpose | Required? |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_SERVICE_KEY` | Service role key | Yes |
| `ANTHROPIC_API_KEY` | Claude (default provider for search/enrich/classify) | Yes (for default flows) |
| `OPENAI_API_KEY` | OpenAI provider | Optional |
| `GEMINI_API_KEY` | Google Gemini provider | Optional |
| `XAI_API_KEY` | xAI Grok provider | Optional |
| `BRIGHTDATA_API_TOKEN` | BrightData Web Unlocker | Optional (falls back to direct fetch) |
| `BRIGHTDATA_ZONE` | BD zone name; default `'influencer_proxy1'` ([verify.js:17](influencer-tool/api/verify.js#L17)) | No |
| `BRIGHTDATA_PROXY_URL` | BD residential proxy URL (raw TCP tunnel) | Optional (IG + TT) |
| `APIFY_API_TOKEN` | Apify actors: Instagram discovery + post enrichment (IG/TikTok/X) | Yes (for IG/TikTok/X discovery + post enrichment) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 — recent-videos post enrichment (§2.4b) | Optional (needed for YouTube post enrichment) |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | TikTok Research API path ([verify.js:772-776](influencer-tool/api/verify.js#L772-L776)) | Optional (alt to Apify) |
| `APP_PASSWORD` | Simple shared-secret gate on all API routes ([_auth.js:6](influencer-tool/api/_auth.js#L6)) | Optional (unset = open) |

### 3.2 Hardcoded constants

| Constant | Value | Location |
|---|---|---|
| `MAX_WEB_SEARCHES` (search) | 8 | [search.js:8](influencer-tool/api/search.js#L8) |
| `MAX_WEB_SEARCHES` (enrich) | 4 | [enrich.js:9](influencer-tool/api/enrich.js#L9) |
| Search `max_tokens` | 4096 | [search.js:105](influencer-tool/api/search.js#L105) |
| Enrich `max_tokens` | 1200 | [enrich.js:8](influencer-tool/api/enrich.js#L8) |
| Classify `max_tokens` | 300 | [classify.js:104](influencer-tool/api/classify.js#L104) |
| Classify concurrency | 10 | [classify.js:209](influencer-tool/api/classify.js#L209) |
| Main Results page size | 50 | [index.html:564](influencer-tool/public/index.html#L564) (`PAGE_SIZE`) |
| BD Results page size | 100 | [index.html:8038](influencer-tool/public/index.html#L8038) (`BDR_PAGE_SIZE`) |
| Search-cache chunk size | 500 | [index.html:4589](influencer-tool/public/index.html#L4589) (`BD_CHUNK_SIZE`) |
| Reclassify save chunk | 300 | [index.html:6760](influencer-tool/public/index.html#L6760) |
| IG pages per cookie | 3 | [verify.js:472](influencer-tool/api/verify.js#L472) |
| IG max hashtag pages | 15 | [verify.js:473](influencer-tool/api/verify.js#L473) |
| Default models | Sonnet 4.6 (search/enrich); Haiku 4.5 (classify); GPT-5.5 (OpenAI default in search.js) | [enrich.js:7](influencer-tool/api/enrich.js#L7), [search.js:95](influencer-tool/api/search.js#L95), [search.js:123](influencer-tool/api/search.js#L123), [classify.js:176](influencer-tool/api/classify.js#L176) |

### 3.3 Provider/model menu (frontend)

From [index.html:1808-1820](influencer-tool/public/index.html#L1808-L1820):
- Anthropic: `claude-sonnet-4-6` (recommended), `claude-haiku-4-5-20251001` (fastest)
- OpenAI: `gpt-5.5`
- Gemini, Grok: client-passed model strings

### 3.4 Dataset switching

`tablesForDataset()` in db-save.js:
```
food      → matching: brightdata_profiles,  excluded: brightdata_excluded_profiles
lifestyle → matching: lifestyle_bloggers,   excluded: lifestyle_bloggers_excluded
```

### 3.5 localStorage keys

| Key | Purpose |
|---|---|
| `appPassword` | API password for `X-App-Password` header |
| `influencer_keywords` | Sidebar default keywords list |
| `influencer_sources` | Enabled discovery sources |
| `activeMainTab` | Last-viewed tab |
| `bd_cookie_pool` | Instagram cookie pool — **retired** (UI removed; multi-account no longer used) |
| `tt_session_cookie` | TikTok cookie (still used) |
| `x_cookie_pool` | X cookie pool — **retired** (UI removed; X uses Apify) |
| `bd_filter_state` | Saved filter groups |
| `bd_filter_panel_collapsed`, `bdr_filter_panel_collapsed` | UI collapse state |
| `bd_cached_results_meta` + `bd_cached_results_chunk_{i}` | Chunked search-results cache |
| `bd_type_labels` (`BDR_TYPE_KEY`) | Creator-type assignments per `{platform}:{handle}` ([index.html:6435](influencer-tool/public/index.html#L6435)) |
| `bd_llm_meta` (`BDR_LLM_KEY`) | Tier + uk_based + food_focus per `{platform}:{handle}` ([index.html:6436](influencer-tool/public/index.html#L6436)) |
| `enrichment_results` | Enrichment in-progress cache ([index.html:2916](influencer-tool/public/index.html#L2916)) |

---

## 4. Data model — Supabase tables

Each row below maps to a table actually referenced by `supabase.from('...')`. Columns listed are the ones the code reads or writes (DB schema may have more).

### 4.1 `influencers` — main list
Mapped by [db-load.js:7-37](influencer-tool/api/db-load.js#L7-L37).
Columns: `handle` (PK), `name`, `platform`, `ig_handle`, `ig_followers`, `tt_handle`, `tt_followers`, `yt_handle`, `yt_followers`, `x_handle`, `x_followers`, `followers`, `content_labels`, `who_they_are`, `what_they_post`, `tone_style`, `target_audience`, `why_follow`, `found_via`, `niche`, `location`, `bucket`, `is_verified`, `post_count`, `follower_verified`, `created_at`, `updated_at`.

### 4.2 `influencer_snapshots` — change log
Read by [db-changes.js](influencer-tool/api/db-changes.js). Columns: `id`, `handle`, `field_name`, `old_value`, `new_value`, `run_at`, `influencer_id`.

### 4.3 BrightData (food) tables
- `brightdata_profiles` — matching/approved
- `brightdata_excluded_profiles` — filtered-out (kept for review)

Row shape (saved by `bdToRow` in db-save.js, columns filtered against actual DB schema): `handle`, `platform`, `raw_platform`, `full_name`, `bio`, `followers`, `engagement_rate`, `avg_likes`, `avg_comments`, `post_count`, `is_verified`, `is_private`, `country`, `location`, `language`, `avatar_url`, `profile_url`, `matched_keywords` (json), `post_captions` (json), `post_locations` (json), `fetched_at`, `influencer_type`, `influencer_tier`, `tier_reason`, `uk_based`, `food_focus`, `relevancy`.

### 4.4 Lifestyle tables
- `lifestyle_bloggers`
- `lifestyle_bloggers_excluded`

Same shape as the BrightData tables.

The matching/excluded tables also carry post-enrichment aggregates: `avg_likes`, `avg_comments`, `avg_views`, `avg_saves`, `avg_shares`, `engagement_rate` (recomputed from `profile_posts`).

### 4.4b `profile_posts` — recent posts per creator
Created by [sql/profile_posts.sql](influencer-tool/sql/profile_posts.sql); written by the post-enrichment fetchers (§2.4b) via `postToRow` in [post-enrich.js](influencer-tool/api/post-enrich.js). One row per post, unique on `(handle, platform, post_id)`.
Columns: `handle`, `platform`, `post_id`, `post_url`, `type`, `caption`, `hashtags` (json), `mentions` (json), `likes`, `comments`, `views`, `saves`, `shares`, `posted_at`, `location`, `tagged_users` (json), `music`, `duration_sec`, `is_short`, `thumbnail_url`, `media_urls` (json), `raw` (json), `fetched_at`. `saves`/`shares` are null for Instagram/YouTube; `is_short` = short-form video (`duration_sec <= 180`).

### 4.5 `manual_influencers`
Written by [/api/manual-import](influencer-tool/api/manual-import.js). Used by Coverage tab to compare against BD discoveries.

### 4.6 `banned_influencers`
GET/POST/DELETE via [/api/ban](influencer-tool/api/ban.js). Columns: `handle`, `reason`, `banned_at`.

### 4.7 `outreach`
Pipeline records — fields match the modal form ([index.html:4286-4341](influencer-tool/public/index.html#L4286-L4341)): `handle`, `email`, `mobile`, `agency`, `contacted_date`, `responded`, `responded_date`, `price_min`, `price_max`, `deal`. Exact DB column names are determined inside db-save.js `handleOutreachSave` (verify).

### 4.8 `platform_sessions`
Written by [/api/save-session](influencer-tool/api/save-session.js). Columns: `platform` (PK), `cookies` (json), `updated_at`.

### 4.9 `search_run_logs`
GET/POST/PATCH via [/api/search-history](influencer-tool/api/search-history.js). Columns: `id`, `provider`, `model`, `platform`, `keyword`, `location`, `min_followers`, `candidates_found`, `new_in_session`, `accepted`, `banned`, `created_at`.

### 4.10 Presets / saved searches
Referenced by `preset-list|save|delete` and `search-list|save|delete` actions in db-save.js dispatcher ([db-save.js:1273-1278](influencer-tool/api/db-save.js#L1273-L1278)). Table names not surfaced here (verify by reading the handler bodies).

---

## 5. API endpoints

All routes require the `X-App-Password` header if `APP_PASSWORD` is set ([_auth.js:6](influencer-tool/api/_auth.js#L6)). Vercel routes everything under `/api/*.js`.

| Endpoint | Method(s) | Purpose |
|---|---|---|
| [`/api/search`](influencer-tool/api/search.js) | POST | Claude/OpenAI/Gemini/Grok web-search discovery. Returns candidate `influencers[]` + usage. |
| [`/api/enrich`](influencer-tool/api/enrich.js) | POST | Claude-only profile enrichment. Returns 6 narrative fields. |
| [`/api/classify`](influencer-tool/api/classify.js) | POST | Batch tier+type classification (concurrency 10). |
| [`/api/db-load`](influencer-tool/api/db-load.js) | GET | All rows from `influencers`. |
| [`/api/db-changes`](influencer-tool/api/db-changes.js) | GET | Snapshots grouped by handle then run_at. |
| [`/api/db-save`](influencer-tool/api/db-save.js) | POST | Multi-action dispatcher — see §5.1 below. |
| [`/api/ban`](influencer-tool/api/ban.js) | GET/POST/DELETE | Banned-handle list. |
| [`/api/verify`](influencer-tool/api/verify.js) | POST | Per-platform live profile fetch + search/enrich actions (`bd-search`, `bd-search-status`, `bd-scan-posts`, `yt-enrich`). `bd-scan-posts` now runs the shared post-enrichment fetchers (§2.4b); the old multi-account `bd-reenrich` action was removed. |
| [`/api/manual-import`](influencer-tool/api/manual-import.js) | POST | Upsert to `manual_influencers`. |
| [`/api/search-history`](influencer-tool/api/search-history.js) | GET/POST/PATCH | `search_run_logs` CRUD + aggregates. |
| [`/api/save-session`](influencer-tool/api/save-session.js) | POST | Persist platform session cookies. |
| [`/api/compare-bio`](influencer-tool/api/compare-bio.js) | POST | LLM-judged "did this narrative field meaningfully change?" check. |

### 5.1 `/api/db-save` action dispatch

Dispatcher at [db-save.js:1258-1278](influencer-tool/api/db-save.js#L1258-L1278):

| `action` | Handler | What it does |
|---|---|---|
| (default) | top of file | Save/update `influencers` rows + write change snapshots |
| `manual-coverage` | `handleManualCoverage` | Build the Coverage view (manual vs BD overlap) |
| `brightdata-load` | `handleBrightDataLoad` | Paginated load of `{matching,excluded}` for active dataset |
| `brightdata` | `handleBrightDataSave` | Upsert search results into matching/excluded/lifestyle |
| `lifestyle-load` | `handleLifestyleLoad` | Paginated load of `lifestyle_bloggers` only |
| `load-posts` | `handleLoadPosts` | Load a creator's recent posts from `profile_posts` (by handle, optional platform; newest first) — powers the "🖼 Posts" modal in BD Results |
| `brightdata-reclassify` | `handleBrightDataReclassify` | Move rows between matching↔excluded after rule changes |
| `patch-classification` | `handlePatchClassification` | Update `influencer_tier`/`type`/`uk_based`/`food_focus` for one (handle, platform) |
| `patch-profile` | `handlePatchProfile` | Update arbitrary profile field |
| `detect-language` | `handleDetectLanguage` | Run language detection on bios/captions |
| `find-other-platforms` | `handleFindOtherPlatforms` | Cross-platform discovery from a known handle |
| `find-other-platforms-log` | `handleFindOtherPlatformsLog` | Read disk log of platform discoveries |
| `bulk-save-discoveries` | `handleBulkSaveDiscoveries` | Batch insert from `find-other-platforms` |
| `bulk-set-language-from-log` | `handleBulkSetLanguageFromLog` | Batch update languages from prior detect runs |
| `outreach-list` / `outreach-save` / `outreach-delete` | — | Outreach CRUD |
| `preset-list` / `preset-save` / `preset-delete` | — | Filter preset CRUD |
| `search-list` / `search-save` / `search-delete` | — | Saved search keyword CRUD |

---

## 6. Important runtime behaviors

### 6.1 Auth
`checkAuth(req, res)` ([_auth.js:1-29](influencer-tool/api/_auth.js)) compares `X-App-Password` header against `APP_PASSWORD`. If `APP_PASSWORD` is unset, everything is open.

### 6.2 Caching
- BD merge cache (`_bdrMergeCache`, WeakMap keyed by source array) ([index.html:6598](influencer-tool/public/index.html#L6598)) — recently fixed (was dead code).
- Dataset cache (`_bdrDatasetCache`) keeps both food + lifestyle in memory after first fetch.
- Display-rows memo on the legacy Results tab (`_displayCacheKey` / `_displayEpoch`).
- Tab-loaded flags: `_enrichTabLoaded`, `_outreachLoaded`, `_coverageLoaded` skip redundant re-init when switching tabs.

### 6.3 Persistence quirks
- localStorage tier/type caches (`bd_type_labels`, `bd_llm_meta`) can exceed quota with 10K+ classifications; the code clears the offending key and keeps an in-memory cache only ([index.html:6485-6496](influencer-tool/public/index.html#L6485-L6496)).
- Cached BD search results are chunked into multiple localStorage keys to stay under per-key limits ([index.html:4688-4717](influencer-tool/public/index.html#L4688-L4717)).
- Reclassify-save sends matching/excluded in chunks of 300 to stay under Vercel body limits ([index.html:6760-6781](influencer-tool/public/index.html#L6760-L6781)).
