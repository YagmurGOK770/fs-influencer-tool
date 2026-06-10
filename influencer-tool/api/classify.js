// POST /api/classify
// Body: { profiles: [{ handle, platform, full_name, bio, location }], provider, model }
// Returns: { results: [{ handle, platform, entity_type, primary_content_category,
//   primary_food_content_type, food_service_type, food_post_count, total_posts_analyzed,
//   uk_geography, dietary_focus, reasoning, foodstyles_fit, fit_reasoning }] }
//
// Structured-facts classifier (api/classify-core.js — the same prompt the batch runner uses).
// For each creator it fetches the enriched post captions (+ per-post location signal) from
// profile_posts SERVER-SIDE, so uk_geography is judged on real post evidence rather than a bio
// claim. The rule-based Tier is derived from these facts (+ engagement) separately — NOT here.

import { createClient } from '@supabase/supabase-js';
import { classifyCreator } from './_classify-core.js';
import { checkAuth, requireApiKey } from './_auth.js';

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env.local');
  _sb = createClient(url, key);
  return _sb;
}

const lc    = (h) => String(h || '').replace(/^@/, '').toLowerCase();
const canon = (p) => { p = String(p || '').toLowerCase(); if (p.includes('insta')) return 'instagram'; if (p.includes('tik')) return 'tiktok'; if (p.includes('you')) return 'youtube'; if (p === 'x' || p.includes('twit')) return 'x'; return p; };

const CAPTIONS_PER = 30;
// Enriched captions for a creator's classified (top-follower) platform, newest first,
// each tagged with its post location so the model can weigh UK vs non-UK evidence.
async function loadCaptions(sb, handle, platform) {
  const { data, error } = await sb.from('profile_posts')
    .select('caption, location, posted_at')
    .eq('handle', lc(handle)).eq('platform', platform)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(CAPTIONS_PER);
  if (error) { console.warn(`[classify] captions ${handle}: ${error.message}`); return []; }
  return (data || []).map(r => {
    const cap = (r.caption || '').slice(0, 280);
    return r.location ? `${cap} [location: ${r.location}]` : cap;
  }).filter(s => s.trim());
}

const POST_IMAGES = 3;          // how many post images to attach to the vision call
const IMG_CANDIDATES = 30;      // scan the whole post set; keep the first POST_IMAGES that load (re-hosted preferred)
const _isPermImg = (u) => typeof u === 'string' && u.includes('/storage/v1/object/public/'); // re-hosted, never expires
// Fetch a post image and inline it as a base64 data URI. IG/TikTok CDN URLs are often signed/
// expiring or referrer-locked, so we fetch server-side and send bytes rather than a URL the model
// would have to (often fail to) fetch. Returns null on any failure — best-effort, never throws.
async function fetchDataUri(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return null;   // skip empty / >3MB
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}
// Up to POST_IMAGES post images for the classified platform, inlined as data URIs. Candidates are
// newest-first, but RE-HOSTED (permanent Storage) thumbnails are tried first — expiring IG/TikTok CDN
// URLs usually 403, and the re-hosted ones (from a thumbnail refresh) may rank older by posted_at.
async function loadPostImages(sb, handle, platform) {
  const { data, error } = await sb.from('profile_posts')
    .select('thumbnail_url, media_urls, posted_at')
    .eq('handle', lc(handle)).eq('platform', platform)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(IMG_CANDIDATES);
  if (error) { console.warn(`[classify] post-images ${handle}: ${error.message}`); return []; }
  const urls = (data || [])
    .map(r => r.thumbnail_url || (Array.isArray(r.media_urls) ? r.media_urls[0] : null))
    .filter(Boolean);
  urls.sort((a, b) => (_isPermImg(b) ? 1 : 0) - (_isPermImg(a) ? 1 : 0)); // permanent first; stable keeps recency within group
  const out = [];
  for (const u of urls) {
    const d = await fetchDataUri(u);
    if (d) out.push(d);
    if (out.length >= POST_IMAGES) break;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const { profiles, provider = 'anthropic', model = 'claude-haiku-4-5-20251001' } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length) {
    return res.status(400).json({ error: 'profiles array required' });
  }
  if (profiles.length > 100) {
    return res.status(400).json({ error: 'Max 100 profiles per request' });
  }
  if (!requireApiKey(res, provider)) return;

  let sb;
  try { sb = getSupabase(); } catch (e) { return res.status(500).json({ error: e.message }); }

  async function classifyOne(p) {
    const platform = canon(p.platform);
    const [captions, image_urls] = await Promise.all([
      loadCaptions(sb, p.handle, platform),
      loadPostImages(sb, p.handle, platform),
    ]);
    const facts = await classifyCreator(
      { bio: p.bio, full_name: p.full_name, location: p.location, platform, captions, image_urls },
      { provider, model });
    return { handle: p.handle, platform: p.platform, captions_used: captions.length, images_used: image_urls.length, ...facts };
  }

  const CONCURRENCY = 8;
  const results = [];
  for (let i = 0; i < profiles.length; i += CONCURRENCY) {
    const batch = profiles.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(classifyOne));
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        console.error(`[classify] failed for ${batch[j].handle}:`, s.reason?.message);
        results.push({ handle: batch[j].handle, platform: batch[j].platform, error: 'Classification failed: ' + (s.reason?.message || '') });
      }
    });
  }

  console.log(`[classify] provider=${provider} model=${model} classified=${results.length}`);
  return res.status(200).json({ results });
}
