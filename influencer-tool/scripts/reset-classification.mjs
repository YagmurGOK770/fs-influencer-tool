// Reset (clear) the classifier outputs so you can do a fresh run and confirm every row saves.
// Clears the 7 classification columns + tier/tier_manual on all currently-classified rows across the
// 4 source tables. The raw profile data (followers, bio, posts, profile_posts) is NOT touched.
//
// SAFE BY DEFAULT — dry-run unless you pass --confirm.
//   node scripts/reset-classification.mjs              # dry-run: show how many rows would clear
//   node scripts/reset-classification.mjs --confirm    # actually clear
//   node scripts/reset-classification.mjs --confirm --only brightdata_profiles
//
// After clearing: reload the BD Results page (so the in-memory cache resets), then run AI Classify.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/); if (m) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

const TABLES = ['brightdata_profiles', 'brightdata_excluded_profiles', 'lifestyle_bloggers', 'lifestyle_bloggers_excluded'];
const CLEAR = {
  entity_type: null, primary_content_category: null, primary_food_content_type: null,
  food_post_count: null, total_posts_analyzed: null, uk_geography: null, classification_reasoning: null,
};

(async () => {
  console.log(CONFIRM ? '[reset] CONFIRM — clearing classifications…\n' : '[reset] DRY RUN (no writes) — pass --confirm to actually clear\n');
  let grand = 0;
  for (const table of (ONLY ? [ONLY] : TABLES)) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true }).not('entity_type', 'is', null);
    if (error) { console.log(`${table.padEnd(32)} ERROR: ${error.message.split('\n')[0]}`); continue; }
    grand += count || 0;
    console.log(`${table.padEnd(32)} ${count || 0} classified row(s)${CONFIRM ? '' : ' would be cleared'}`);
    if (!CONFIRM || !count) continue;

    // Reset tier first (while entity_type still set as the target filter). Columns may not exist yet
    // if sql/tier_columns.sql hasn't run — ignore that error.
    const { error: tErr } = await sb.from(table).update({ tier: null, tier_manual: false }).not('entity_type', 'is', null);
    if (tErr && !/Could not find the .* column/.test(tErr.message)) console.warn(`  tier reset: ${tErr.message.split('\n')[0]}`);

    // Clear the classification facts.
    const { error: cErr } = await sb.from(table).update(CLEAR).not('entity_type', 'is', null);
    if (cErr) console.warn(`  clear: ${cErr.message.split('\n')[0]}`);
    else console.log(`  → cleared`);
  }
  console.log(`\n${CONFIRM ? 'Cleared' : 'Would clear'} ${grand} classified row(s) total.`);
  if (!CONFIRM && grand) console.log('Re-run with --confirm to apply, then reload the page and run AI Classify.');
})();
