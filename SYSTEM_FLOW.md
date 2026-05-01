# Influencer Tool — System Flow

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (Client)                         │
│                  fs-influencer-tool.vercel.app                  │
│                                                                 │
│   ┌─────────────────────────┐  ┌────────────────────────────┐  │
│   │     Search Tab          │  │     Enrichment Tab         │  │
│   │  - Keywords             │  │  - Batch profile gen       │  │
│   │  - Location             │  │  - Progress bar            │  │
│   │  - Platform             │  │  - Pause / Retry           │  │
│   │  - Min followers        │  │  - Export JSON             │  │
│   │  - Sources toggle       │  │                            │  │
│   │  - CSV upload           │  │                            │  │
│   │  - Results table        │  │                            │  │
│   │  - Export CSV           │  │                            │  │
│   └────────────┬────────────┘  └──────────────┬─────────────┘  │
└────────────────┼─────────────────────────────-┼────────────────┘
                 │ POST /api/search              │ POST /api/enrich
                 │ (X-App-Password header)       │ (X-App-Password header)
                 ▼                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                  VERCEL SERVERLESS FUNCTIONS                     │
│                                                                 │
│  ┌──────────────────────────┐   ┌───────────────────────────┐  │
│  │     /api/search.js       │   │     /api/enrich.js        │  │
│  │  timeout: 300s           │   │  timeout: 60s             │  │
│  │                          │   │                           │  │
│  │  1. checkAuth()          │   │  1. checkAuth()           │  │
│  │  2. requireApiKey()      │   │  2. requireApiKey()       │  │
│  │  3. buildPrompt()        │   │  3. buildPrompt()         │  │
│  │  4. Call Anthropic API   │   │  4. Call Anthropic API    │  │
│  │  5. extractJsonArray()   │   │  5. extractJsonObject()   │  │
│  │  6. Return influencers[] │   │  6. Return profile{}      │  │
│  └──────────────┬───────────┘   └──────────────┬────────────┘  │
│                 │                               │               │
│  ┌──────────────▼───────────────────────────────▼────────────┐ │
│  │                     _auth.js                               │ │
│  │   checkAuth()  → validates X-App-Password header          │ │
│  │   requireApiKey() → checks ANTHROPIC_API_KEY env var      │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                 │                               │
                 ▼                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ANTHROPIC CLAUDE API                        │
│              https://api.anthropic.com/v1/messages              │
│                                                                 │
│  ┌──────────────────────────┐   ┌───────────────────────────┐  │
│  │   Search endpoint        │   │   Enrich endpoint         │  │
│  │   Model: claude-sonnet-  │   │   Model: claude-sonnet-   │  │
│  │         4-6              │   │         4-5               │  │
│  │   Tool: web_search       │   │   No tools (inference)    │  │
│  │   Max searches: 8        │   │   Max tokens: 600         │  │
│  │   Max tokens: 4096       │   │                           │  │
│  └──────────────┬───────────┘   └───────────────────────────┘  │
│                 │                                               │
│  ┌──────────────▼───────────────────────────────────────────┐  │
│  │              Web Search Tool (web_search_20250305)        │  │
│  │   Claude searches the web for real influencer profiles    │  │
│  │   across specified platforms and custom source URLs       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Flow 1: Influencer Search

```
User fills search config
  (keywords, location, platform, min followers, sources)
         │
         ▼
  Clicks "Run Agent"
         │
         ▼
  POST /api/search
  ┌──────────────────────────────────────┐
  │ Auth check → APP_PASSWORD header     │
  │ Key check  → ANTHROPIC_API_KEY       │
  │ Build prompt with search criteria    │
  │ Call Claude (claude-sonnet-4-6)      │
  │   └─ Claude runs up to 8 web        │
  │        searches on platforms &       │
  │        custom source URLs            │
  │   └─ Returns JSON influencer list    │
  │ Parse & extract JSON array           │
  └──────────────────┬───────────────────┘
                     │
                     ▼
         Response: { influencers[], usage }
                     │
                     ▼
         Table populated in browser
         New results highlighted green
                     │
                     ▼
         User reviews → ticks checkboxes
                     │
                     ▼
         Export selected as CSV download
```

---

## Flow 2: Profile Enrichment

```
Influencer list loaded (from search or CSV upload)
         │
         ▼
  User clicks "Start Enrichment"
         │
         ▼
  Process in batches (~5 concurrent)
  For each influencer:
  ┌──────────────────────────────────────┐
  │ POST /api/enrich                     │
  │   { name, handle, platform,          │
  │     followers }                      │
  │ Auth + key checks                    │
  │ Call Claude (claude-sonnet-4-5)      │
  │   └─ Infers profile from public      │
  │        presence (no tools)           │
  │   └─ Returns 6-field JSON profile    │
  │ Parse JSON object                    │
  └──────────────────┬───────────────────┘
                     │
                     ▼
         Response: {
           whoTheyAre, whatTheyPost,
           toneStyle, targetAudience,
           whyFollow, contentLabels
         }
                     │
                     ▼
         Row updated in enrichment table
         Progress bar advances
                     │
                     ▼
         User can pause / retry errors
                     │
                     ▼
         Export all enriched data as JSON
```

---

## Flow 3: CSV Upload

```
User drags or selects a .csv / .xlsx file
         │
         ▼
  FileReader reads file in browser
         │
         ▼
  parseCSV() / XLSX library parses rows
         │
         ▼
  csvRowsToInfluencers() normalises columns
         │
         ▼
  Merged into allRows[] (deduped by handle+platform)
         │
         ▼
  Table re-renders
  Existing influencers flagged (used for dedup in search)
```

---

## Auth Flow

```
Every API request
         │
         ├─ X-App-Password header present?
         │     Yes → matches APP_PASSWORD env var? → continue
         │     No  → APP_PASSWORD set in env?
         │               Yes → 401 Unauthorised
         │               No  → continue (open access)
         │
         └─ ANTHROPIC_API_KEY set in env?
               Yes → attach to Anthropic API call
               No  → 500 Server misconfigured
```

---

## Data Storage

```
┌─────────────────────────────────────────────────────┐
│  NO DATABASE — everything lives in the browser tab  │
│                                                     │
│  allRows[]        ← in-memory JS array              │
│  APP_PASSWORD     ← sessionStorage (cached prompt)  │
│  Exports          ← browser download (CSV / JSON)   │
│                                                     │
│  Vercel functions are stateless — no server state   │
└─────────────────────────────────────────────────────┘
```

---

## Environment Variables (Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Authenticates all Claude API calls |
| `APP_PASSWORD` | No | Optional shared password to gate the tool |
