// Backfill the persisted `tier` column for already-classified rows.
//
// Computes the rule-based tier with the EXACT bdrTierOf() pulled from public/index.html (so it can
// never drift from the UI), and writes it to every classified row. Rows with tier_manual = true are
// left untouched (a human override is never clobbered). FREE — no API calls, just DB reads/writes.
//
// Run (from influencer-tool/):
//   node scripts/backfill-tier.mjs --dry-run     # show the tier distribution, write nothing
//   node scripts/backfill-tier.mjs               # write tier for all classified rows
//   node scripts/backfill-tier.mjs --only brightdata_profiles
//
// Prereq: run sql/tier_columns.sql first (adds tier + tier_manual).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/); if (m) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- Pull the real bdrTierOf() out of the UI so the backfill matches it exactly ---
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('const BD_TIER_META'), html.indexOf('async function bdrClassifyVisible'));
let CUR = {};
const factory = new Function(
  'bdrGetClass', 'bdParseCompact', 'bdFormatCompact', 'BD_UK_META', 'BD_CAT_LABEL', 'BD_FOODTYPE_LABEL',
  code + '\n;return bdrTierOf;'
);
// bdParseCompact must handle "22M", "7206255", "1.33K" etc. — same as the UI.
const bdParseCompact = (v) => {
  if (v == null) return 0;
  let s = String(v).trim().toLowerCase().replace(/,/g, '').replace(/\+/g, ''); if (!s) return 0;
  let mul = 1; if (s.endsWith('m')) { mul = 1e6; s = s.slice(0, -1); } else if (s.endsWith('k')) { mul = 1e3; s = s.slice(0, -1); } else if (s.endsWith('b')) { mul = 1e9; s = s.slice(0, -1); }
  const n = parseFloat(s); return Number.isNaN(n) ? 0 : Math.round(n * mul);
};
const bdrTierOf = factory(() => CUR, bdParseCompact, n => String(n),
  new Proxy({}, { get: (_, k) => ({ short: String(k) }) }), new Proxy({}, { get: (_, k) => String(k) }), new Proxy({}, { get: (_, k) => String(k) }));

// tier for one DB row (its own followers = primary_followers, since classification is per top platform)
function ruleTierForRow(r) {
  CUR = {
    entity_type: r.entity_type, primary_content_category: r.primary_content_category,
    primary_food_content_type: r.primary_food_content_type, food_post_count: r.food_post_count,
    total_posts_analyzed: r.total_posts_analyzed, uk_geography: r.uk_geography,
  };
  const t = bdrTierOf({ handle: r.handle, platforms: [r.platform], primary_followers: r.followers });
  return t.status === 'tier' ? t.tier : null; // 1–4 | null (filtered/unclassified)
}

const TABLES = ['brightdata_profiles', 'lifestyle_bloggers'];
async function mapPool(items, n, worker) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await worker(items[k]); } })); }

(async () => {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, filtered: 0 };
  let updated = 0, skippedManual = 0, unchanged = 0, total = 0;
  for (const table of (ONLY ? [ONLY] : TABLES)) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table)
        .select('handle, platform, followers, entity_type, primary_content_category, primary_food_content_type, food_post_count, total_posts_analyzed, uk_geography, tier, tier_manual')
        .not('entity_type', 'is', null).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    console.log(`[backfill] ${table}: ${rows.length} classified rows`);
    await mapPool(rows, 10, async (r) => {
      total++;
      const t = ruleTierForRow(r);
      dist[t == null ? 'filtered' : t]++;
      if (r.tier_manual === true) { skippedManual++; return; }     // never clobber a manual override
      if (r.tier === t) { unchanged++; return; }
      if (DRY_RUN) { updated++; return; }
      const { error } = await sb.from(table).update({ tier: t }).eq('handle', r.handle).eq('platform', r.platform);
      if (error) console.warn(`  ${r.handle}@${r.platform}: ${error.message}`);
      else updated++;
    });
  }
  console.log(`\nTier distribution (all classified): ${JSON.stringify(dist)}`);
  console.log(`${DRY_RUN ? 'WOULD update' : 'Updated'} ${updated} · unchanged ${unchanged} · manual-preserved ${skippedManual} · total ${total}`);
})();
