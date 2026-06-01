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
//   node scripts/enrich-posts-batch.mjs --only instagram     # one platform only (instagram|tiktok|x|youtube)
//   node scripts/enrich-posts-batch.mjs --force              # re-enrich even if posts already exist
//   node scripts/enrich-posts-batch.mjs --ig-batch 50        # profiles per Apify run for ig/tiktok (default 50)
//   node scripts/enrich-posts-batch.mjs --concurrency 8      # concurrent calls for x/youtube loops
//
// Resumable: skips handles that already have profile_posts rows (unless --force). Every person's
// result is appended to scripts/enrich-posts-batch.jsonl as it completes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { fetchPostsForPlatform, postToRow, computeAggregates } from '../api/post-enrich.js';

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
const ONLY        = getFlag('--only');            // instagram | tiktok | x | youtube
const IG_BATCH    = Number(getFlag('--ig-batch')) || 50;
const CONCURRENCY = Number(getFlag('--concurrency')) || 8;

const LOG_PATH = path.join(__dirname, 'enrich-posts-batch.jsonl');
const log = (entry) => { try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {} };

// ── connect ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOURCE_TABLES = ['brightdata_profiles', 'brightdata_excluded_profiles', 'lifestyle_bloggers', 'lifestyle_bloggers_excluded'];

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
        if (e.handle && typeof e.posts === 'number') set.add(lc(e.handle));
      } catch {}
    }
  } catch {}
  return set;
}

// ── 2. persist one person's posts + refresh aggregates ──────────────────────
async function persistPerson(person, posts) {
  const rows = posts.map(p => postToRow(person.handle, person.platform, p)).filter(r => r.post_id);
  if (rows.length) {
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await supabase.from('profile_posts')
        .upsert(rows.slice(i, i + 300), { onConflict: 'handle,platform,post_id' });
      if (error) throw new Error(`profile_posts upsert: ${error.message}`);
    }
  }
  // Refresh source-row aggregates only when we actually got posts — never clobber previously
  // computed metrics with nulls from an empty/failed fetch. Match the canonical platform
  // (same value used for profile_posts), consistent with the verify.js path.
  if (posts.length) {
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

  if (ONLY) people = people.filter(p => p.platform === ONLY);

  if (!FORCE) {
    const enriched = await loadEnrichedHandles();   // handles with profile_posts rows
    const attempted = loadAttemptedFromLog();        // handles with a prior completed attempt (incl. 0 posts)
    const skip = new Set([...enriched, ...attempted]);
    const before = people.length;
    people = people.filter(p => !skip.has(p.handle));
    console.log(`[enrich] skipping ${before - people.length} already-attempted (${enriched.size} with posts, ${attempted.size} from log); ${people.length} remaining`);
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

  const byHandle = new Map(people.map(p => [p.handle, p]));
  let processed = 0, postsWritten = 0;

  // Apify-batched platforms: chunk profiles into one actor run per chunk.
  for (const plat of ['instagram', 'tiktok']) {
    const arr = groups[plat];
    for (let i = 0; i < arr.length; i += IG_BATCH) {
      const chunk = arr.slice(i, i + IG_BATCH);
      console.log(`[enrich:${plat}] run ${i / IG_BATCH + 1} — ${chunk.length} profiles (${i + chunk.length}/${arr.length})`);
      let map;
      try {
        map = await fetchPostsForPlatform(plat, chunk.map(p => ({ handle: p.handle, profileUrl: p.profileUrl })),
          { onProgress: ({ itemCount }) => process.stdout.write(`\r  …${itemCount} items`) });
        process.stdout.write('\n');
      } catch (e) {
        console.warn(`[enrich:${plat}] chunk fetch failed: ${e.message}`);
        log({ platform: plat, error: e.message, chunkStart: i });
        continue; // whole-chunk fetch failed — nothing to persist
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
    console.log(`[enrich:${plat}] ${arr.length} profiles (concurrency ${CONCURRENCY})`);
    const map = await fetchPostsForPlatform(plat, arr.map(p => ({ handle: p.handle, profileUrl: p.profileUrl })),
      { concurrency: CONCURRENCY, onProgress: ({ itemCount }) => process.stdout.write(`\r  …${itemCount}/${arr.length}`) });
    process.stdout.write('\n');
    for (const person of arr) {
      const posts = map.get(person.handle) || [];
      try {
        const n = await persistPerson(person, posts);
        postsWritten += n; processed++;
        log({ handle: person.handle, platform: plat, posts: n });
      } catch (e) { console.warn(`[enrich:${plat}] ${person.handle}: ${e.message}`); log({ handle: person.handle, platform: plat, error: e.message }); }
    }
  }

  console.log(`[enrich] done — ${processed} people enriched, ${postsWritten} posts written`);
})();
