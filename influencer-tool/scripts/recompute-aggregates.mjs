// Recompute per-creator aggregates (median_*, avg_*, recent_daily_*, reach inputs, engagement_rate,
// posts_sampled, last_post_at) from the ALREADY-STORED profile_posts rows — no Apify / no API calls,
// so it's FREE for every platform. Use this to backfill new aggregate fields onto creators that were
// enriched before those fields existed, instead of paying to re-fetch.
//
// Usage (from influencer-tool/):
//   node scripts/recompute-aggregates.mjs                 # recompute everyone with stored posts
//   node scripts/recompute-aggregates.mjs --dry-run       # show what would change, no writes
//   node scripts/recompute-aggregates.mjs --only instagram

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { computeAggregates } from '../api/post-enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
    if (m) process.env[m[1]] = m[2];
  }
}
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOURCE_TABLES = ['brightdata_profiles', 'brightdata_excluded_profiles', 'lifestyle_bloggers', 'lifestyle_bloggers_excluded'];
const lc = (h) => String(h || '').replace(/^@/, '').toLowerCase();
const canon = (p) => { p = String(p || '').toLowerCase(); if (p.includes('insta')) return 'instagram'; if (p.includes('tik')) return 'tiktok'; if (p.includes('you')) return 'youtube'; if (p === 'x' || p.includes('twit')) return 'x'; return p; };
function parseFollowers(v) {
  if (v == null) return 0; let s = String(v).trim().toLowerCase().replace(/,/g, '').replace(/\+/g, ''); if (!s) return 0;
  let m = 1; if (s.endsWith('m')) { m = 1e6; s = s.slice(0, -1); } else if (s.endsWith('k')) { m = 1e3; s = s.slice(0, -1); } else if (s.endsWith('b')) { m = 1e9; s = s.slice(0, -1); }
  const n = parseFloat(s); return Number.isNaN(n) ? 0 : Math.round(n * m);
}

// 1. Load all stored posts, grouped by handle|platform.
async function loadPostGroups() {
  const groups = new Map();
  const seen = new Map(); // key -> Set(post_id), dedupes rows in case offset-paging overlaps a
                          // concurrently-written table (otherwise aggregates over duplicated posts).
  const PAGE = 1000;
  // Order by the immutable id PK so pagination is stable under concurrent inserts (new rows append
  // at higher ids and aren't re-read), rather than the default non-deterministic order.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('profile_posts')
      .select('handle, platform, post_id, likes, comments, views, saves, shares, posted_at, fetched_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load profile_posts at ${from}: ${error.message}`);
    for (const r of (data || [])) {
      const plat = canon(r.platform);
      if (ONLY && plat !== ONLY) continue;
      const key = `${lc(r.handle)}|${plat}`;
      if (!groups.has(key)) { groups.set(key, []); seen.set(key, new Set()); }
      const ids = seen.get(key);
      if (r.post_id != null && ids.has(r.post_id)) continue; // skip duplicate row
      if (r.post_id != null) ids.add(r.post_id);
      groups.get(key).push({
        likes: r.likes, comments: r.comments, views: r.views, saves: r.saves, shares: r.shares,
        postedAt: r.posted_at, fetchedAt: r.fetched_at,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return groups;
}

(async () => {
  console.log('[recompute] loading stored posts…');
  const groups = await loadPostGroups();
  console.log(`[recompute] ${groups.size} creator-platform groups with stored posts`);

  let updated = 0, skipped = 0;
  for (const table of SOURCE_TABLES) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(table).select('handle, platform, raw_platform, followers').order('handle', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(`load ${table} at ${from}: ${error.message}`);
      for (const row of (data || [])) {
        const plat = canon(row.platform || row.raw_platform);
        if (ONLY && plat !== ONLY) continue;
        const posts = groups.get(`${lc(row.handle)}|${plat}`);
        if (!posts || !posts.length) { skipped++; continue; }
        const agg = computeAggregates(posts, parseFollowers(row.followers));
        if (DRY_RUN) { updated++; continue; }
        const { error: upErr } = await sb.from(table).update(agg).eq('handle', row.handle).eq('platform', row.platform);
        if (upErr) console.warn(`[recompute] ${row.handle}@${table}: ${upErr.message}`);
        else updated++;
      }
      if (!data || data.length < PAGE) break;
    }
  }
  console.log(`[recompute] ${DRY_RUN ? 'would update' : 'updated'} ${updated} rows (${skipped} source rows had no stored posts)`);
})();
