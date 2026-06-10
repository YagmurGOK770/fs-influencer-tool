// Batch classifier — runs the structured-facts prompt (api/classify-core.js) over the dataset,
// feeding each creator's bio/name/location + their enriched post captions (with per-post location
// signals, which the uk_geography logic relies on) from profile_posts. Writes the 7 new columns to
// the source row. One classification per person (their top-follower platform), deduped by handle.
//
// Usage (from influencer-tool/):
//   node scripts/classify-batch.mjs --dry-run            # show who'd be classified, no LLM/no write
//   node scripts/classify-batch.mjs --limit 5            # classify 5 (small live test)
//   node scripts/classify-batch.mjs                      # classify everyone not yet classified
//   node scripts/classify-batch.mjs --provider anthropic --model claude-haiku-4-5-20251001
//   node scripts/classify-batch.mjs --force              # re-classify even if already done
// Resumable: skips rows whose entity_type is already set (unless --force).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { classifyCreator } from '../api/classify-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) { const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/); if (m) process.env[m[1]] = m[2]; }

const args = process.argv.slice(2);
const getFlag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const hasFlag = (n) => args.includes(n);
const DRY_RUN = hasFlag('--dry-run');
const FORCE = hasFlag('--force');
const LIMIT = Number(getFlag('--limit')) || Infinity;
const PROVIDER = getFlag('--provider') || 'anthropic';
const MODEL = getFlag('--model') || 'claude-haiku-4-5-20251001';
const CONCURRENCY = Number(getFlag('--concurrency')) || 8;
const CAPTIONS_PER = Number(getFlag('--captions')) || 30;
// Scope to a subset (e.g. the creators just refreshed by the 30-post re-crawl): only classify people
// whose TOP-follower platform is in --only (comma-sep) and whose followers are >= --min-followers.
const ONLY = getFlag('--only');                                    // instagram | tiktok | youtube | x (comma-sep ok)
const MIN_FOLLOWERS = getFlag('--min-followers') ? parseFollowers(getFlag('--min-followers')) : 0;
// Resume: skip handles already SUCCESSFULLY classified in this pass (a log entry with `entity` in the
// last N hours, default 12), so a re-launch after an interruption doesn't re-classify / re-charge them.
const RESUME = hasFlag('--resume');
const RESUME_HOURS = Number(getFlag('--resume-hours')) || 12;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const LOG_PATH = path.join(__dirname, 'classify-batch.jsonl');
const log = (e) => { try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); } catch {} };

const SOURCE_TABLES = ['brightdata_profiles', 'lifestyle_bloggers'];
const lc = (h) => String(h || '').replace(/^@/, '').toLowerCase();
const canon = (p) => { p = String(p || '').toLowerCase(); if (p.includes('insta')) return 'instagram'; if (p.includes('tik')) return 'tiktok'; if (p.includes('you')) return 'youtube'; if (p === 'x' || p.includes('twit')) return 'x'; return p; };
const PLATFORM_PRIORITY = { instagram: 0, tiktok: 1, youtube: 2, x: 3 };
function parseFollowers(v) { if (v == null) return 0; let s = String(v).trim().toLowerCase().replace(/,/g, '').replace(/\+/g, ''); if (!s) return 0; let m = 1; if (s.endsWith('m')) { m = 1e6; s = s.slice(0, -1); } else if (s.endsWith('k')) { m = 1e3; s = s.slice(0, -1); } else if (s.endsWith('b')) { m = 1e9; s = s.slice(0, -1); } const n = parseFloat(s); return Number.isNaN(n) ? 0 : Math.round(n * m); }

async function mapPool(items, n, worker) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); } })); return out; }

async function loadAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('handle, platform, raw_platform, followers, full_name, bio, location, entity_type').range(from, from + 999);
    if (error) throw new Error(`load ${table}: ${error.message}`);
    rows.push(...(data || []).map(r => ({ ...r, _table: table })));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// Dedupe by handle → the top-follower platform (the one we enriched / has captions).
async function buildPeople() {
  const best = new Map();
  for (const t of SOURCE_TABLES) {
    for (const r of await loadAll(t)) {
      const handle = lc(r.handle); if (!handle) continue;
      const platform = canon(r.platform || r.raw_platform);
      if (!['instagram', 'tiktok', 'youtube', 'x'].includes(platform)) continue;
      const followers = parseFollowers(r.followers);
      const cur = best.get(handle);
      const better = !cur || followers > cur.followers || (followers === cur.followers && PLATFORM_PRIORITY[platform] < PLATFORM_PRIORITY[cur.platform]);
      if (better) best.set(handle, { handle, platform, followers, table: t, full_name: r.full_name, bio: r.bio, location: r.location, classified: r.entity_type != null });
    }
  }
  return [...best.values()];
}

// Captions (+ per-post location signal) for a creator's enriched platform, newest first.
async function loadCaptions(handle, platform) {
  const { data, error } = await sb.from('profile_posts')
    .select('caption, location, posted_at').eq('handle', lc(handle)).eq('platform', platform)
    .order('posted_at', { ascending: false, nullsFirst: false }).limit(CAPTIONS_PER);
  if (error) { console.warn(`[captions] ${handle}: ${error.message}`); return []; }
  return (data || []).map(r => {
    const cap = (r.caption || '').slice(0, 280);
    return r.location ? `${cap} [location: ${r.location}]` : cap;
  }).filter(s => s.trim());
}

const POST_IMAGES = 3, IMG_CANDIDATES = 30;   // scan whole post set; re-hosted (permanent) thumbnails preferred
const _isPermImg = (u) => typeof u === 'string' && u.includes('/storage/v1/object/public/');
// Fetch a post image and inline it as a base64 data URI (CDN URLs are often signed/expiring, so we
// send bytes, not a URL the model would have to fetch). Best-effort: returns null on any failure.
async function fetchDataUri(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return null;
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}
// Up to POST_IMAGES post images for the enriched platform, inlined as data URIs. Re-hosted (permanent)
// thumbnails are tried first — expiring CDN URLs 403, and re-hosted ones may rank older by posted_at.
async function loadPostImages(handle, platform) {
  const { data, error } = await sb.from('profile_posts')
    .select('thumbnail_url, media_urls, posted_at').eq('handle', lc(handle)).eq('platform', platform)
    .order('posted_at', { ascending: false, nullsFirst: false }).limit(IMG_CANDIDATES);
  if (error) { console.warn(`[post-images] ${handle}: ${error.message}`); return []; }
  const urls = (data || [])
    .map(r => r.thumbnail_url || (Array.isArray(r.media_urls) ? r.media_urls[0] : null))
    .filter(Boolean);
  urls.sort((a, b) => (_isPermImg(b) ? 1 : 0) - (_isPermImg(a) ? 1 : 0));
  const out = [];
  for (const u of urls) {
    const d = await fetchDataUri(u);
    if (d) out.push(d);
    if (out.length >= POST_IMAGES) break;
  }
  return out;
}

(async () => {
  console.log('[classify] loading people…');
  let people = await buildPeople();
  console.log(`[classify] ${people.length} distinct people`);
  const onlySet = ONLY ? new Set(ONLY.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) : null;
  if (onlySet || MIN_FOLLOWERS) {
    const before = people.length;
    people = people.filter(p => (!onlySet || onlySet.has(p.platform)) && p.followers >= MIN_FOLLOWERS);
    console.log(`[classify] scope (${onlySet ? [...onlySet].join('+') : 'any platform'}, >=${MIN_FOLLOWERS} followers): ${before} -> ${people.length}`);
  }
  if (!FORCE) { const before = people.length; people = people.filter(p => !p.classified); console.log(`[classify] skipping ${before - people.length} already classified; ${people.length} remaining`); }
  if (RESUME) {
    const cutoff = Date.now() - RESUME_HOURS * 3600 * 1000;
    const done = new Set();
    try { for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.handle && e.entity && Date.parse(e.ts) >= cutoff) done.add(lc(e.handle)); } catch {} } } catch {}
    const before = people.length;
    people = people.filter(p => !done.has(lc(p.handle)));
    console.log(`[classify] --resume: skipping ${before - people.length} classified in last ${RESUME_HOURS}h; ${people.length} remaining`);
  }
  if (people.length > LIMIT) people = people.slice(0, LIMIT);

  if (DRY_RUN) {
    const split = {}; for (const p of people) split[p.platform] = (split[p.platform] || 0) + 1;
    console.log('[classify] DRY RUN — would classify', people.length, JSON.stringify(split));
    console.log('  e.g.', people.slice(0, 5).map(p => `${p.handle}(${p.platform})`).join(', '));
    process.exit(0);
  }

  let done = 0, ok = 0;
  await mapPool(people, CONCURRENCY, async (person) => {
    try {
      const [captions, image_urls] = await Promise.all([
        loadCaptions(person.handle, person.platform),
        loadPostImages(person.handle, person.platform),
      ]);
      const facts = await classifyCreator(
        { bio: person.bio, full_name: person.full_name, location: person.location, platform: person.platform, captions, image_urls },
        { provider: PROVIDER, model: MODEL });
      const { error } = await sb.from(person.table).update({
        entity_type: facts.entity_type,
        primary_content_category: facts.primary_content_category,
        primary_food_content_type: facts.primary_food_content_type,
        food_service_type: facts.food_service_type,
        food_post_count: facts.food_post_count,
        total_posts_analyzed: facts.total_posts_analyzed,
        uk_geography: facts.uk_geography,
        dietary_focus: facts.dietary_focus,
        classification_reasoning: facts.reasoning,
        foodstyles_fit: facts.foodstyles_fit,
        fit_reasoning: facts.fit_reasoning,
      }).eq('handle', person.handle).eq('platform', person.platform);
      if (error) throw new Error(error.message);
      ok++; log({ handle: person.handle, platform: person.platform, entity: facts.entity_type, cat: facts.primary_content_category, uk: facts.uk_geography });
    } catch (e) {
      console.warn(`[classify] ${person.handle}: ${e.message}`);
      log({ handle: person.handle, platform: person.platform, error: e.message });
    }
    if (++done % 50 === 0) console.log(`[classify] ${done}/${people.length}`);
  });
  console.log(`[classify] done — ${ok}/${people.length} classified`);
})();
