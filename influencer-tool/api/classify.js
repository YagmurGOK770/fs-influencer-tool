// POST /api/classify
// Body: { profiles: [{ handle, platform, full_name, bio, location }], provider, model }
// Returns: { results: [{ handle, platform, entity_type, primary_content_category,
//   primary_food_content_type, food_post_count, total_posts_analyzed, uk_geography, reasoning }] }
//
// Structured-facts classifier (api/classify-core.js — the same prompt the batch runner uses).
// For each creator it fetches the enriched post captions (+ per-post location signal) from
// profile_posts SERVER-SIDE, so uk_geography is judged on real post evidence rather than a bio
// claim. The rule-based Tier is derived from these facts (+ engagement) separately — NOT here.

import { createClient } from '@supabase/supabase-js';
import { classifyCreator } from './classify-core.js';
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
    const captions = await loadCaptions(sb, p.handle, platform);
    const facts = await classifyCreator(
      { bio: p.bio, full_name: p.full_name, location: p.location, platform, captions },
      { provider, model });
    return { handle: p.handle, platform: p.platform, captions_used: captions.length, ...facts };
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
