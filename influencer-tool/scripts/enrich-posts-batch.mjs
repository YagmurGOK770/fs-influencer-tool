// Batch post-enrichment runner.
//
// For every person across the discovery datasets, picks the platform where they have the
// MOST followers and fetches their recent ~30 posts/videos with per-post engagement, then
// stores them in profile_posts and refreshes the profile-level aggregates.
//
// One platform per person; people are deduped by handle across all source tables.
//   Instagram / TikTok / X  → Apify (paid).  YouTube → official Data API (free).
//
// Usage (from influencer-tool/):
//   node scripts/enrich-posts-batch.mjs                      # everything not yet enriched
//   node scripts/enrich-posts-batch.mjs --dry-run            # plan only: counts + platform split, no fetch/write
//   node scripts/enrich-posts-batch.mjs --limit 20           # cap people processed (test run)
//   node scripts/enrich-posts-batch.mjs --only instagram     # one platform only (comma-sep ok: instagram,tiktok)
//   node scripts/enrich-posts-batch.mjs --force              # re-enrich even if posts already exist
//   node scripts/enrich-posts-batch.mjs --replace            # full re-crawl: replace the stored post set with the fresh
//                                                            # fetch (prune stale rows) + refresh aggregates (use with --force)
//   node scripts/enrich-posts-batch.mjs --min-followers 10000 # only people with >= N followers (accepts 10k / 1m)
//   node scripts/enrich-posts-batch.mjs --only instagram,tiktok --posts 3 --force
//                                                            # THUMBNAIL REFRESH: over-fetches a buffer (posts are returned
//                                                            # pinned/jumbled), keeps the LATEST 3 by date, re-hosts their
//                                                            # images to Storage; leaves captions + aggregates intact
//   node scripts/enrich-posts-batch.mjs --force --replace --posts 30 --only instagram,tiktok --min-followers 10000
//                                                            # FULL RE-CRAWL: refetch the latest 30 IG/TikTok posts for every
//                                                            # creator >=10k, REPLACE the stored set (prune stale rows ->
//                                                            # exactly the fresh 30), refresh aggregates + last_post_at, and
//                                                            # re-host thumbnails to Storage
//   node scripts/enrich-posts-batch.mjs --force --replace --posts 30 --only instagram,tiktok --min-followers 10000 --resume
//                                                            # RESUME the above after a mid-run stop: skips the accounts this
//                                                            # pass already completed (since the last run-start marker), so no
//                                                            # account is re-fetched / re-charged. Re-run as often as needed.
//   node scripts/enrich-posts-batch.mjs --ig-batch 50        # profiles per Apify run for ig/tiktok (default 50)
//   node scripts/enrich-posts-batch.mjs --concurrency 8      # concurrent calls for x/youtube loops
//
// Resumable: skips handles that already have profile_posts rows (unless --force). Every person's
// result is appended to scripts/enrich-posts-batch.jsonl as it completes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { fetchPostsForPlatform, postToRow, computeAggregates, isHardLimit, persistThumbnails } from '../api/post-enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── env ─────────────────────────────────────────────────────────────────────
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
    if (m) process.env[m[1]] = m[2];
  }
}

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getFlag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const hasFlag = (name) => args.includes(name);
const DRY_RUN     = hasFlag('--dry-run');
const FORCE       = hasFlag('--force');
const LIMIT       = Number(getFlag('--limit')) || Infinity;
const ONLY        = getFlag('--only');            // instagram | tiktok | x | youtube (comma-separated ok)
const POSTS       = Number(getFlag('--posts')) || null;  // keep the latest N posts/profile for ig/tiktok (e.g. 3 to refresh just the LLM images)
// Full re-crawl: replace the stored post set with the fresh fetch (prune stale rows) and recompute
// aggregates. Distinguishes a 30-post re-crawl from a small --posts thumbnail refresh (use with --force).
const REPLACE     = hasFlag('--replace');
// Only enrich people whose top-platform follower count is >= this (accepts 10000 / "10k" / "1m"). 0 = all.
const MIN_FOLLOWERS = getFlag('--min-followers') ? parseFollowers(getFlag('--min-followers')) : 0;
// Resumable re-crawl: --resume skips handles already processed SINCE THE LAST run-start marker (each
// fresh, non-resume run drops one in the log). Applies even under --force, so re-running after a mid-run
// stop (e.g. an Apify usage limit) continues where it left off instead of re-fetching — and re-charging —
// the accounts already done. Marker-scoped (not a wall-clock window), so unrelated recent runs don't
// cause it to skip accounts this pass hasn't reached yet. JSONL-only, no DB cost.
const RESUME = hasFlag('--resume');
// Actors return pinned/jumbled order. For a SMALL keep-count the pins dominate the result, so over-fetch
// a buffer then keep the latest N by date. For a full re-crawl (N>=30) the few pins are a minor fraction
// and sort below the recent posts by date, so fetch exactly N (no costly buffer).
const REFRESH_FETCH = POSTS ? (POSTS < 30 ? POSTS + 12 : POSTS) : null;
const IG_BATCH    = Number(getFlag('--ig-batch')) || 50;
const CONCURRENCY = Number(getFlag('--concurrency')) || 8;
// Re-attempt handles previously logged with 0 posts. Use this to recover creators whose earlier
// fetch FAILED (e.g. an Apify usage-limit run logged them as 0) — older code couldn't tell a failed
// fetch from a genuinely-empty profile. Handles with stored posts are still always skipped.
const RETRY_EMPTY = hasFlag('--retry-empty');

const LOG_PATH = path.join(__dirname, 'enrich-posts-batch.jsonl');
const log = (entry) => { try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {} };

// ── connect ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOURCE_TABLES = ['brightdata_profiles', 'lifestyle_bloggers'];

// ── helpers ───────────────────────────────────────────────────────────────
function parseFollowers(v) {
  if (v == null) return 0;
  let s = String(v).trim().toLowerCase().replace(/,/g, '').replace(/\+/g, '');
  if (!s) return 0;
  let mult = 1;
  if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : Math.round(n * mult);
}
function canonPlatform(p) {
  p = String(p || '').toLowerCase();
  if (p.includes('insta') || p === 'ig') return 'instagram';
  if (p.includes('tik') || p === 'tt') return 'tiktok';
  if (p.includes('you') || p === 'yt') return 'youtube';
  if (p === 'x' || p.includes('twitter')) return 'x';
  return p || 'other';
}
const lc = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();

async function loadAll(table) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table)
      .select('handle, platform, raw_platform, followers, profile_url')
      .range(from, from + PAGE - 1);
    // Fatal: a silent partial load would drop people from the run or (via the skip-set) re-charge
    // paid actors. Abort so the operator can retry rather than proceeding on incomplete data.
    if (error) throw new Error(`load ${table} failed at offset ${from}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Tie-break when follower counts are equal (often both 0/unknown): deterministic platform
// preference instead of source-table iteration order.
const PLATFORM_PRIORITY = { instagram: 0, tiktok: 1, youtube: 2, x: 3 };

// ── 1. build the deduped people list, each routed to their top-follower platform ──
async function buildPeople() {
  const best = new Map(); // handle -> { handle, platform, followers, profileUrl, table }
  for (const t of SOURCE_TABLES) {
    const rows = await loadAll(t);
    for (const r of rows) {
      const handle = lc(r.handle);
      if (!handle) continue;
      const platform = canonPlatform(r.platform || r.raw_platform);
      if (!['instagram', 'tiktok', 'youtube', 'x'].includes(platform)) continue;
      const followers = parseFollowers(r.followers);
      const cur = best.get(handle);
      const better = !cur
        || followers > cur.followers
        || (followers === cur.followers && PLATFORM_PRIORITY[platform] < PLATFORM_PRIORITY[cur.platform]);
      if (better) {
        best.set(handle, { handle, platform, followers, profileUrl: r.profile_url || null, table: t });
      }
    }
  }
  return [...best.values()];
}

// handles already present in profile_posts (for resumability)
async function loadEnrichedHandles() {
  const set = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('profile_posts').select('handle').range(from, from + PAGE - 1);
    // Fatal: an underfilled enriched-set would re-fetch (re-charge) already-done handles.
    if (error) throw new Error(`load enriched handles failed at offset ${from}: ${error.message}`);
    for (const r of (data || [])) set.add(lc(r.handle));
    if (!data || data.length < PAGE) break;
  }
  return set;
}

// Handles with a prior COMPLETED attempt (success OR a legitimate 0-post result) from the JSONL
// log. Lets resume skip dead/empty/unresolvable handles so we never re-charge paid actors for
// them every run. Errored attempts (no `posts` field) are intentionally NOT skipped, so they retry.
function loadAttemptedFromLog() {
  const set = new Set();
  try {
    if (!fs.existsSync(LOG_PATH)) return set;
    for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e.handle || typeof e.posts !== 'number') continue;
        if (RETRY_EMPTY && e.posts === 0) continue; // re-attempt 0-post handles (recover failed fetches)
        set.add(lc(e.handle));
      } catch {}
    }
  } catch {}
  return set;
}

// Handles with a SUCCESSFUL (posts) log entry AFTER the most recent run-start marker. Powers --resume:
// a fresh run drops a {recrawl_marker} line, then logs each completed handle; on a later --resume run
// this returns exactly the handles this pass already finished, so they're skipped (no re-fetch / re-
// charge). Marker-scoped — not a time window — so it's robust to multiple resumes and to unrelated
// recent runs. JSONL-only, no DB cost. Empty set if there's no marker yet (→ nothing skipped).
function loadDoneSinceMarker() {
  const set = new Set();
  try {
    if (!fs.existsSync(LOG_PATH)) return set;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(l => l.trim());
    let markerTs = 0;
    for (const l of lines) { try { const e = JSON.parse(l); if (e.recrawl_marker && Date.parse(e.ts)) markerTs = Date.parse(e.ts); } catch {} }
    if (!markerTs) return set;
    for (const l of lines) { try { const e = JSON.parse(l); if (e.handle && typeof e.posts === 'number' && Date.parse(e.ts) >= markerTs) set.add(lc(e.handle)); } catch {} }
  } catch {}
  return set;
}

// ── 2. persist one person's posts + refresh aggregates ──────────────────────
async function persistPerson(person, posts) {
  // --posts refresh: actors return pinned/jumbled order, so we over-fetched a buffer — now keep only
  // the LATEST POSTS by date, so the re-hosted thumbnails are genuinely the most recent posts.
  if (POSTS) posts = [...posts].sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0)).slice(0, POSTS);
  // Dedupe by post_id — some scrapers (notably the X actor) return the same post twice in one
  // result set; a single upsert batch can't touch the same (handle,platform,post_id) row twice
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const byId = new Map();
  for (const p of posts) { const r = postToRow(person.handle, person.platform, p); if (r.post_id) byId.set(r.post_id, r); }
  const rows = [...byId.values()];

  // --replace re-crawl: decide whether the fresh fetch looks COMPLETE before we let it overwrite
  // history. The Apify actor can under-return for a single profile (private / rate-limited / pagination
  // cutoff) on a run that otherwise SUCCEEDS — returning e.g. 5 of a creator's 30 posts. Pruning to
  // those 5 (and recomputing aggregates from them) would silently delete good rows from a prior full
  // crawl and corrupt last_post_at / engagement. So if the fresh set is much smaller than what's
  // already stored, treat it as partial and leave the existing posts + metrics untouched. The count
  // is read BEFORE the upsert, so it reflects the prior crawl, not the rows we're about to write.
  let replacePartial = false;
  if (REPLACE && rows.length) {
    const { count: priorCount, error: cErr } = await supabase.from('profile_posts')
      .select('post_id', { count: 'exact', head: true })
      .eq('handle', person.handle).eq('platform', person.platform);
    if (cErr) { console.warn(`[replace] ${person.handle}: prior-count check failed (${cErr.message}) — skipping prune to be safe`); replacePartial = true; }
    else if (priorCount && rows.length < priorCount * 0.5) {
      console.warn(`[replace] ${person.handle}: fresh ${rows.length} << stored ${priorCount} — likely a partial fetch; keeping existing posts/metrics`);
      replacePartial = true;
    }
  }

  if (rows.length) {
    await persistThumbnails(supabase, rows);   // re-host expiring IG/TikTok thumbnails before saving
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await supabase.from('profile_posts')
        .upsert(rows.slice(i, i + 300), { onConflict: 'handle,platform,post_id' });
      if (error) throw new Error(`profile_posts upsert: ${error.message}`);
    }
    // --replace (full re-crawl): the fresh rows now define the stored set. The upsert ran FIRST (so the
    // creator never has zero posts even if this prune fails), so now delete any stale rows for this
    // (handle, platform) that aren't in the fresh set. Skipped on an empty fetch (rows.length === 0,
    // whole block) or a suspected partial fetch (above), so we NEVER wipe a good prior crawl. The
    // keep-list reuses the EXACT upserted post_id strings (each double-quoted; postgrest-js URL-encodes
    // the value, so commas/parens are safe; a quote in an id — never for IG/TikTok/X/YT — would only
    // make PostgREST reject the filter → caught below → no deletion). A prune error is non-fatal:
    // leftover stale rows are harmless (readers take the latest N by date), so just warn.
    if (REPLACE && !replacePartial) {
      const keep = '(' + rows.map(r => `"${String(r.post_id)}"`).join(',') + ')';
      const { error: delErr } = await supabase.from('profile_posts')
        .delete().eq('handle', person.handle).eq('platform', person.platform)
        .not('post_id', 'in', keep);
      if (delErr) console.warn(`[replace] ${person.handle}: prune stale rows failed: ${delErr.message}`);
    }
  }
  // Refresh source-row aggregates only when we got a TRUSTWORTHY full set — never clobber previously
  // computed metrics with values from an empty / failed / partial fetch. Recompute on: normal enrichment
  // (no --posts) OR a --replace re-crawl that wasn't flagged partial. A small --posts refresh WITHOUT
  // --replace (e.g. --posts 3 for LLM thumbnails) skips it: metrics from a few posts are worse than the
  // existing full-set values and would clobber last_post_at (used by the tier rule). Match the canonical
  // platform (same value used for profile_posts), consistent with the verify.js path.
  if (posts.length && (!POSTS || REPLACE) && !replacePartial) {
    const agg = computeAggregates(posts, person.followers);
    const { error: aggErr } = await supabase.from(person.table)
      .update(agg).eq('handle', person.handle).eq('platform', person.platform);
    if (aggErr) console.warn(`[agg] ${person.handle}@${person.table}: ${aggErr.message}`);
  }
  return rows.length;
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[enrich] loading source tables…');
  let people = await buildPeople();
  const total = people.length;

  // platform split (for the dry-run summary / progress)
  const split = {};
  for (const p of people) split[p.platform] = (split[p.platform] || 0) + 1;
  console.log(`[enrich] ${total} distinct people. Platform split: ${JSON.stringify(split)}`);

  const onlySet = ONLY ? new Set(ONLY.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) : null;
  if (onlySet) people = people.filter(p => onlySet.has(p.platform));

  if (MIN_FOLLOWERS) {
    const before = people.length;
    people = people.filter(p => p.followers >= MIN_FOLLOWERS);
    console.log(`[enrich] follower filter >=${MIN_FOLLOWERS}: ${before} -> ${people.length}`);
  }

  if (!FORCE) {
    const enriched = await loadEnrichedHandles();   // handles with profile_posts rows
    const attempted = loadAttemptedFromLog();        // handles with a prior completed attempt (incl. 0 posts)
    const skip = new Set([...enriched, ...attempted]);
    const before = people.length;
    people = people.filter(p => !skip.has(p.handle));
    console.log(`[enrich] skipping ${before - people.length} already-attempted (${enriched.size} with posts, ${attempted.size} from log); ${people.length} remaining`);
  }

  // Resume support: drop handles already processed since the last run-start marker (even under --force).
  if (RESUME) {
    const done = loadDoneSinceMarker();
    const before = people.length;
    people = people.filter(p => !done.has(p.handle));
    console.log(`[enrich] --resume: skipping ${before - people.length} already processed since last run-start; ${people.length} remaining`);
  }

  if (people.length > LIMIT) people = people.slice(0, LIMIT);

  // group remaining by platform
  const groups = { instagram: [], tiktok: [], x: [], youtube: [] };
  for (const p of people) groups[p.platform].push(p);

  if (DRY_RUN) {
    console.log('[enrich] DRY RUN — would process:');
    for (const [plat, arr] of Object.entries(groups)) {
      if (!arr.length) continue;
      console.log(`  ${plat}: ${arr.length}  e.g. ${arr.slice(0, 5).map(p => `${p.handle}(${p.followers})`).join(', ')}`);
    }
    process.exit(0);
  }

  // Drop a run-start marker so a later --resume run knows which handles THIS pass has completed. Skipped
  // on a --resume run (it continues the existing pass and must keep referencing the original marker).
  if (!RESUME) log({ recrawl_marker: true });

  const byHandle = new Map(people.map(p => [p.handle, p]));
  let processed = 0, postsWritten = 0;

  // All three of these run on Apify; once the account's monthly limit is hit, they all fail —
  // stop trying so we don't churn (and don't mislog anyone as done). YouTube uses a separate quota.
  let apifyStopped = false;

  // Apify-batched platforms: chunk profiles into one actor run per chunk.
  for (const plat of ['instagram', 'tiktok']) {
    const arr = groups[plat];
    if (apifyStopped && arr.length) { console.warn(`[enrich:${plat}] skipped — Apify usage limit hit; will retry next run`); continue; }
    for (let i = 0; i < arr.length; i += IG_BATCH) {
      const chunk = arr.slice(i, i + IG_BATCH);
      console.log(`[enrich:${plat}] run ${i / IG_BATCH + 1} — ${chunk.length} profiles (${i + chunk.length}/${arr.length})`);
      let map;
      try {
        map = await fetchPostsForPlatform(plat, chunk.map(p => ({ handle: p.handle, profileUrl: p.profileUrl })),
          { postsPerProfile: REFRESH_FETCH || undefined, onProgress: ({ itemCount }) => process.stdout.write(`\r  …${itemCount} items`) });
        process.stdout.write('\n');
      } catch (e) {
        console.warn(`[enrich:${plat}] chunk fetch failed: ${e.message}`);
        log({ platform: plat, error: e.message, chunkStart: i });
        if (isHardLimit(e)) { apifyStopped = true; console.warn('[enrich] Apify usage limit hit — stopping Apify platforms'); break; }
        continue; // whole-chunk fetch failed — nothing to persist (chunk handles retry next run)
      }
      // Persist each profile independently: one DB error must not drop the rest of the
      // (already-billed) chunk and leave them unlogged → re-charged on the next resume.
      for (const person of chunk) {
        const posts = map.get(person.handle) || [];
        try {
          const n = await persistPerson(person, posts);
          postsWritten += n; processed++;
          log({ handle: person.handle, platform: plat, posts: n });
        } catch (e) {
          console.warn(`[enrich:${plat}] ${person.handle}: ${e.message}`);
          log({ handle: person.handle, platform: plat, error: e.message });
        }
      }
    }
  }

  // Per-profile platforms (concurrency-limited inside the fetcher).
  for (const plat of ['x', 'youtube']) {
    const arr = groups[plat];
    if (!arr.length) continue;
    if (plat === 'x' && apifyStopped) { console.warn(`[enrich:x] skipped — Apify usage limit hit; will retry next run`); continue; }
    console.log(`[enrich:${plat}] ${arr.length} profiles (concurrency ${CONCURRENCY})`);
    const map = await fetchPostsForPlatform(plat, arr.map(p => ({ handle: p.handle, profileUrl: p.profileUrl })),
      { concurrency: CONCURRENCY, onProgress: ({ itemCount }) => process.stdout.write(`\r  …${itemCount}/${arr.length}`) });
    process.stdout.write('\n');
    for (const person of arr) {
      // Absent from the map = fetch failed or was skipped on a usage limit — leave it UNLOGGED so
      // it retries next run. Only a present value (incl. genuine []) counts as a completed attempt.
      const posts = map.get(person.handle);
      if (posts === undefined) { log({ handle: person.handle, platform: plat, error: 'not fetched (error or usage limit) — will retry' }); continue; }
      try {
        const n = await persistPerson(person, posts);
        postsWritten += n; processed++;
        log({ handle: person.handle, platform: plat, posts: n });
      } catch (e) { console.warn(`[enrich:${plat}] ${person.handle}: ${e.message}`); log({ handle: person.handle, platform: plat, error: e.message }); }
    }
  }

  console.log(`[enrich] done — ${processed} people enriched, ${postsWritten} posts written`);
})();
