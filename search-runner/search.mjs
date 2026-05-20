/**
 * Standalone YouTube / X / TikTok / Instagram keyword search runner.
 *
 * Usage:
 *   node search.mjs --platform youtube --keywords keywords.txt [--concurrency 8]
 *   node search.mjs --platform x       --keywords keywords.txt [--concurrency 4]
 *   node search.mjs --platform youtube --keywords keywords.txt --dry-run
 *
 * Options:
 *   --platform    youtube | x | instagram | tiktok  (default: youtube)
 *   --keywords    path to a text file — one keyword per line, or comma-separated
 *   --concurrency keywords searched in parallel (default: 8 for YT, 4 for X, 1 for IG)
 *   --dry-run     search but don't save to Supabase
 *   --no-enrich   skip YouTube /about enrichment step
 *
 * Results are saved to Supabase (brightdata_profiles) as they complete.
 * Progress is printed to stdout; errors go to stderr.
 *
 * Env vars (loaded from ../.env.local or .env.local in this folder):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, BRIGHTDATA_API_TOKEN, BRIGHTDATA_ZONE
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────────────────────────
function loadEnv(...candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      console.log(`[env] loaded ${p}`);
      return;
    }
  }
}
loadEnv(
  path.join(__dirname, '.env.local'),
  path.join(__dirname, '..', 'influencer-tool', '.env.local'),
);

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
}
const platform    = arg('--platform', 'youtube').toLowerCase();
const keywordsFile = arg('--keywords', null);
const dryRun      = args.includes('--dry-run');
const noEnrich    = args.includes('--no-enrich');
const DEFAULT_CONCURRENCY = platform === 'youtube' ? 8 : 1;
const concurrency = parseInt(arg('--concurrency', String(DEFAULT_CONCURRENCY)), 10);

if (!keywordsFile) {
  console.error('Usage: node search.mjs --platform youtube --keywords keywords.txt [--concurrency 8] [--dry-run] [--no-enrich]');
  process.exit(1);
}

const rawKw = fs.readFileSync(keywordsFile, 'utf8');
const keywords = rawKw
  .split(/[\n,]/)
  .map(k => k.trim())
  .filter(Boolean);

if (!keywords.length) { console.error('No keywords found in file.'); process.exit(1); }

console.log(`[config] platform=${platform}  keywords=${keywords.length}  concurrency=${concurrency}  dryRun=${dryRun}  noEnrich=${noEnrich}`);

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = !dryRun
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

async function saveToDB(profiles) {
  if (dryRun || !profiles.length) return;
  const rows = profiles
    .filter(p => p.handle && p.platform)
    .map(p => ({
      handle:          (p.handle || '').toLowerCase().trim(),
      platform:        p.rawPlatform || p.platform || platform,
      full_name:       p.fullName   || null,
      followers:       p.followers  || null,
      bio:             p.bio        || null,
      post_count:      p.postCount  || null,
      is_verified:     p.isVerified ?? null,
      engagement_rate: p.engagementRate != null ? String(p.engagementRate) : null,
      avg_likes:       p.avgLikes    ?? null,
      matched_keywords: Array.isArray(p.matchedKeywords) ? p.matchedKeywords : null,
      post_captions:   Array.isArray(p.postCaptions)  ? p.postCaptions  : null,
      post_locations:  Array.isArray(p.postLocations) ? p.postLocations : null,
      location:        p.location   || null,
      country:         p.country    || null,
      profile_url:     p.profileUrl || null,
      avatar_url:      p.avatarUrl  || null,
      raw_platform:    p.rawPlatform || platform,
      fetched_at:      new Date().toISOString(),
    }));

  // Batch upsert in chunks of 300
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await supabase
      .from('brightdata_profiles')
      .upsert(rows.slice(i, i + 300), { onConflict: 'handle,platform' });
    if (error) console.error('[db] upsert error:', error.message);
  }
}

// ── YouTube search ────────────────────────────────────────────────────────────
function extractBalancedJson(str, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc)       { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr)     continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  throw new Error('unbalanced JSON');
}

async function ytEnrichOne(handle, profileUrl) {
  const base = (profileUrl || `https://www.youtube.com/@${handle}`).replace(/\/about\/?$/, '');
  const url  = `${base}/about`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 15000);
  let html;
  try {
    const resp = await fetch(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) { clearTimeout(t); throw e; }

  const MARKERS = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  let data = null;
  for (const marker of MARKERS) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    try { data = JSON.parse(extractBalancedJson(html, idx + marker.length)); break; } catch (_) {}
  }
  if (!data) throw new Error('no ytInitialData');

  function deepFind(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (key in node) return node[key];
    for (const v of Object.values(node)) {
      const r = Array.isArray(v)
        ? v.reduce((a, x) => a !== undefined ? a : deepFind(x, key), undefined)
        : deepFind(v, key);
      if (r !== undefined) return r;
    }
  }

  const aboutVM    = deepFind(data, 'aboutChannelViewModel');
  const totalViews = String(aboutVM?.viewCountText || '').replace(/\s*views?/i, '').replace(/,/g, '').trim();
  let country      = aboutVM?.country || deepFind(data, 'channelMetadataRenderer')?.country || '';
  let subscribers  = String(aboutVM?.subscriberCountText || '').replace(/\s*subscribers?/i, '').trim();
  const vtRaw      = deepFind(data, 'videoCountText');
  let videoCount   = (vtRaw?.runs?.map(r => r.text).join('') || vtRaw?.simpleText || '').replace(/\s*videos?/i, '').replace(/,/g, '').trim();

  if (!videoCount || !subscribers) {
    const rows2 = data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    for (const row of rows2) {
      for (const part of (row.metadataParts || [])) {
        const txt = part.text?.content || '';
        if (!subscribers) { const m = txt.match(/([\d.,]+[KMB]?)\s+subscribers?/i); if (m) subscribers = m[1]; }
        if (!videoCount)  { const m = txt.match(/([\d,]+[KMBTkmbt]?)\s+videos?/i);  if (m) videoCount  = m[1].replace(/,/g, ''); }
      }
    }
  }

  const description = aboutVM?.description?.content
    || deepFind(data, 'channelMetadataRenderer')?.description
    || '';

  return { subscribers, totalViews, videoCount, country, description };
}

async function ytKeywordSearch(keyword) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 30000);
  let html;
  try {
    const resp = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`,
      {
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    if (!resp.ok) throw new Error(`YouTube search HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) { clearTimeout(t); throw e; }

  const MARKERS = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  let data = null;
  for (const marker of MARKERS) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    try { data = JSON.parse(extractBalancedJson(html, idx + marker.length)); break; } catch (_) {}
  }
  if (!data) throw new Error('could not parse ytInitialData');

  const seen     = new Set();
  const profiles = [];

  function buildProfile(ch) {
    const channelId    = ch.channelId || ch.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!channelId || seen.has(channelId)) return null;
    seen.add(channelId);
    const canonicalUrl = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    const atMatch      = canonicalUrl.match(/^\/@(.+)$/);
    const handle       = atMatch ? atMatch[1] : channelId;
    const subText      = ch.subscriberCountText?.simpleText || ch.subscriberCountText?.runs?.map(r => r.text).join('') || '';
    const followers    = subText.replace(/\s*subscribers?/i, '').trim();
    const name         = ch.title?.simpleText || ch.title?.runs?.map(r => r.text).join('') || handle;
    const avatar       = ch.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';
    const verified     = !!(ch.ownerBadges || ch.badges || []).some?.(b => b?.metadataBadgeRenderer?.style?.includes('VERIFIED'));
    return {
      handle,
      fullName:    name,
      followers:   followers || null,
      isVerified:  verified,
      avatarUrl:   avatar ? (avatar.startsWith('//') ? 'https:' + avatar : avatar) : null,
      profileUrl:  canonicalUrl ? `https://www.youtube.com${canonicalUrl}` : `https://www.youtube.com/channel/${channelId}`,
      rawPlatform: 'youtube',
      platform:    'youtube',
      matchedKeywords: [keyword],
    };
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.channelRenderer) { const p = buildProfile(node.channelRenderer); if (p) profiles.push(p); }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  }
  walk(data);

  // Paginate up to 2 more pages
  function extractContinuation(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.continuationCommand?.token) return node.continuationCommand.token;
    if (node.token && typeof node.token === 'string' && node.token.length > 20) return node.token;
    for (const v of Object.values(node)) {
      const r = Array.isArray(v) ? v.reduce((a, x) => a || extractContinuation(x), null) : extractContinuation(v);
      if (r) return r;
    }
    return null;
  }

  let token = extractContinuation(data);
  for (let page = 2; page <= 3 && token; page++) {
    try {
      const ctrlP = new AbortController();
      const tP    = setTimeout(() => ctrlP.abort(), 20000);
      let pageResp;
      try {
        pageResp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'x-youtube-client-name': '1',
            'x-youtube-client-version': '2.20241201.00.00',
          },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20241201.00.00', hl: 'en', gl: 'US' } },
            continuation: token,
          }),
          signal: ctrlP.signal,
        });
      } finally { clearTimeout(tP); }
      if (!pageResp.ok) break;
      const pageData = await pageResp.json();
      walk(pageData);
      token = extractContinuation(pageData);
    } catch (e) { break; }
  }

  // Enrich in parallel batches of 10 (no Vercel timeout here — run as many as we like)
  if (!noEnrich) {
    const BATCH = 10;
    for (let i = 0; i < profiles.length; i += BATCH) {
      await Promise.all(profiles.slice(i, i + BATCH).map(async p => {
        try {
          const e = await ytEnrichOne(p.handle, p.profileUrl);
          if (e.videoCount)               p.postCount  = e.videoCount;
          if (e.totalViews)               p.totalViews = e.totalViews;
          if (e.country)                  p.location   = e.country;
          if (e.description)              p.bio        = e.description;
          if (e.subscribers && /^\d/.test(e.subscribers)) p.followers = e.subscribers;
        } catch (_) {}
      }));
    }
  }

  return profiles;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit, onDone) {
  const queue   = [...tasks];
  let active    = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    function next() {
      while (active < limit && queue.length) {
        const task = queue.shift();
        active++;
        task()
          .then(result => { active--; completed++; onDone(result, completed, tasks.length); next(); })
          .catch(err  => { active--; completed++; onDone(null, completed, tasks.length, err); next(); });
      }
      if (active === 0 && queue.length === 0) resolve();
    }
    next();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const startTime  = Date.now();
const profileMap = new Map(); // handle → profile (dedupe across keywords)
let   saved      = 0;
let   failed     = 0;

console.log(`\nStarting search — ${keywords.length} keywords, ${concurrency} in parallel\n`);

const searchFn = platform === 'youtube' ? ytKeywordSearch : null;
if (!searchFn) { console.error(`Platform "${platform}" not yet supported in standalone runner. Add it to search.mjs.`); process.exit(1); }

const tasks = keywords.map((kw, idx) => async () => {
  const kwStart = Date.now();
  const profiles = await searchFn(kw);
  const elapsed  = ((Date.now() - kwStart) / 1000).toFixed(1);
  // Merge into global map
  for (const p of profiles) {
    const key = p.handle?.toLowerCase();
    if (!key) continue;
    if (profileMap.has(key)) {
      const ex = profileMap.get(key);
      ex.matchedKeywords = [...new Set([...(ex.matchedKeywords || []), kw])];
    } else {
      profileMap.set(key, p);
    }
  }
  // Save this keyword's profiles immediately
  await saveToDB(profiles);
  saved += profiles.length;
  return { kw, count: profiles.length, elapsed };
});

await runWithConcurrency(tasks, concurrency, (result, done, total, err) => {
  if (err || !result) {
    failed++;
    console.error(`[${done}/${total}] FAILED — ${err?.message || 'unknown error'}`);
  } else {
    const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const eta = total > done
      ? (((Date.now() - startTime) / done) * (total - done) / 60000).toFixed(0)
      : 0;
    console.log(`[${done}/${total}] "${result.kw}" → ${result.count} channels (${result.elapsed}s) | total unique: ${profileMap.size} | ETA: ${eta}min`);
  }
});

const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
console.log(`\nDone in ${totalMin} min — ${profileMap.size} unique profiles, ${failed} failed keywords`);
if (dryRun) console.log('(dry-run: nothing saved to DB)');
else        console.log(`Saved to brightdata_profiles in Supabase.`);
