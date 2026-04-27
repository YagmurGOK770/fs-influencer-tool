# Influencer Discovery Tool

A live influencer discovery and enrichment dashboard for the FoodStyles team. Deployed on Vercel, calls the Claude API directly for both web search and profile enrichment.

## What it does

- **Live search** — searches the web for new food influencers based on your keywords, location, and custom directories. No more copying prompts into chat.
- **Enrichment** — generates a 6-field profile (who they are, what they post, tone/style, audience, why follow, content labels) for each influencer in your list.
- **CSV upload** — paste in a fresh CSV each session; no database needed.
- **Sources are flexible** — toggle Instagram/TikTok/YouTube/X built-ins, plus add custom URL directories like Tribe Group, Collabstr, Heepsy, etc.
- **Optional team password** — single shared password gates the API endpoints so randos can't burn through your API budget.

## Stack

- Vercel serverless functions (Node 18+) for `/api/search` and `/api/enrich`
- Static `public/index.html` (single-file dashboard)
- Anthropic API: Opus for search (with `web_search_20250305` tool), Sonnet for enrichment

## Setup

### 1. Install Vercel CLI (one time)

```bash
npm i -g vercel
```

### 2. Get an Anthropic API key

Go to https://console.anthropic.com/ → Settings → API Keys → Create Key. Save it somewhere safe.

### 3. Link this folder to a Vercel project

From the project root:

```bash
vercel link
```

Pick "Create a new project" the first time, accept the defaults.

### 4. Set environment variables

In the Vercel dashboard for the project (Settings → Environment Variables), or via CLI:

```bash
vercel env add ANTHROPIC_API_KEY production
# paste your key when prompted

# Optional but recommended for a 3-5 person team:
vercel env add APP_PASSWORD production
# pick something memorable like "foodstyles2026"
```

Repeat for `preview` and `development` environments if you want them.

### 5. Run locally

```bash
vercel dev
```

This starts a local server (usually http://localhost:3000) with the API routes wired up. You'll need a `.env.local` file with the same variables for local dev:

```bash
cp .env.example .env.local
# edit .env.local and fill in your key
```

### 6. Deploy

```bash
vercel --prod
```

Vercel will give you a URL like `https://your-project.vercel.app`. Send that to your team.

## How team members use it

1. Open the URL.
2. First time: enter the team password (the one you set as `APP_PASSWORD`). It's stored in their browser session, not asked again until they close the tab.
3. Upload their CSV in the "Dataset" card if not already loaded.
4. Click **Search & Import Results** to open the search modal.
5. Click **Search now** — Claude searches the web for ~30-90 seconds and returns parsed JSON which auto-imports into the dashboard.
6. Switch to the **Enrichment** tab and click **Start enrichment** to fill in the 6-field profile for each influencer in batches.

## Costs to know about

- **Claude web search** is metered separately from token usage and typically costs more than a regular API call. Each `/api/search` invocation can do up to 8 web searches. Budget accordingly.
- **Enrichment** is much cheaper — it's a single Sonnet call per influencer (~600 tokens out).
- Vercel Hobby plan caps function `maxDuration` at 60s by default; this project bumps `/api/search` to 300s in `vercel.json`. If your team hits the Hobby plan limits, upgrade to Pro.

## Adjusting search behaviour

Edit `api/search.js`:

- `MODEL` — currently `claude-opus-4-5`. Swap for sonnet if you want it cheaper/faster.
- `MAX_WEB_SEARCHES` — default 8. Lower it to spend less per search.
- The prompt builder `buildPrompt(...)` — tweak the inclusion/exclusion rules if you want different filters.

For enrichment, edit `api/enrich.js` — same pattern.

## Caveats

- **Tribe Group and Collabstr require login** for most creator data. Claude's web search can crawl their public landing pages but won't extract creator profiles from behind their auth wall. Treat them as "manual reminders to check separately" rather than primary search targets.
- Web search results aren't deterministic — running the same query twice can return slightly different lists. That's fine for discovery; just dedupe afterwards.
- The dashboard loads ~385 hardcoded influencers as the demo dataset. Replace `EXISTING_DATA` in `public/index.html` with your real CSV-imported data, or use the upload button each session.

## Files

```
.
├── api/
│   ├── _auth.js        # password + API key check
│   ├── search.js       # POST /api/search → Claude + web search
│   └── enrich.js       # POST /api/enrich → Claude (no web search)
├── public/
│   └── index.html      # the dashboard (single file)
├── .env.example        # template for env vars
├── .gitignore
├── package.json
├── vercel.json         # function timeout config
└── README.md
```

## Troubleshooting

**"Server misconfigured: ANTHROPIC_API_KEY not set"**
You forgot to add the env var in Vercel, or didn't redeploy after adding it. Run `vercel --prod` again.

**"Unauthorized — invalid or missing password"**
The `APP_PASSWORD` env var on the server doesn't match what you typed. Click the browser refresh, the prompt will reappear.

**Search returns no parseable results**
Claude returned text but our JSON extractor couldn't find an array. The raw text gets shown in the modal — copy it, fix the JSON manually, and paste into the "Import this JSON" textarea. If this happens often, tighten the prompt in `api/search.js` to insist harder on a fenced ```json block.

**Function timeout (504)**
Claude took longer than 300s. Reduce `MAX_WEB_SEARCHES` in `api/search.js` or upgrade to Vercel Pro.
