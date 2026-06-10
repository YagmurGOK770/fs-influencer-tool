// GET /api/db-load
// Returns all influencers from the DB, mapped back to frontend shape.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

function toFrontend(row) {
  return {
    handle:        row.handle,
    name:          row.name          || '',
    platform:      row.platform      || '',
    igHandle:      row.ig_handle     || '',
    igFollowers:   row.ig_followers  || '',
    ttHandle:      row.tt_handle     || '',
    ttFollowers:   row.tt_followers  || '',
    ytHandle:      row.yt_handle     || '',
    ytFollowers:   row.yt_followers  || '',
    xHandle:       row.x_handle      || '',
    xFollowers:    row.x_followers   || '',
    followers:     row.followers     || '',
    contentLabels: row.content_labels|| '',
    whoTheyAre:    row.who_they_are  || '',
    whatTheyPost:  row.what_they_post|| '',
    toneStyle:     row.tone_style    || '',
    targetAudience:row.target_audience|| '',
    whyFollow:     row.why_follow    || '',
    foundVia:      row.found_via     || '',
    niche:         row.niche         || '',
    location:      row.location      || '',
    bucket:        row.bucket        || '',
    isVerified:       row.is_verified       || false,
    postCount:        row.post_count        || '',
    followerVerified: row.follower_verified || false,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

// ── Same-origin image proxy (folded in here to stay under the Hobby-plan 12-function cap) ──────
// GET /api/db-load?u=<base64 image URL> relays public social-CDN image bytes so Instagram/Facebook
// thumbnails load from our origin — bypassing ad/tracker blockers (which block *.cdninstagram.com /
// *.fbcdn.net) plus referrer/CORP quirks. Unauthenticated by necessity (an <img> can't send the
// app-password header); kept safe by a strict host allowlist (SSRF guard), https-only, and
// image-content-type + size checks. It only ever relays public CDN image bytes.
const _IMG_ALLOWED_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|ytimg\.com|twimg\.com)$/i;
const _IMG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB abuse cap — thumbnails are tiny

async function serveProxiedImage(req, res, qs) {
  let target;
  try {
    const b64 = qs.get('u'); const plain = qs.get('url');
    let raw = plain || '';
    if (b64) { try { raw = Buffer.from(String(b64), 'base64').toString('utf8'); } catch { raw = ''; } }
    if (!raw) { res.status(400).end('url required'); return; }
    target = new URL(raw);
  } catch { res.status(400).end('bad url'); return; }
  if (target.protocol !== 'https:' || !_IMG_ALLOWED_HOST.test(target.hostname)) {
    res.status(403).end('host not allowed'); return;
  }
  try {
    // TikTok's image CDN is hotlink-protected — send a tiktok.com Referer so the fetch isn't 403'd.
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' };
    if (/tiktokcdn(-us)?\.com$/i.test(target.hostname)) headers['Referer'] = 'https://www.tiktok.com/';
    const up = await fetch(target.href, { headers });
    if (!up.ok) { res.status(up.status).end('upstream ' + up.status); return; }
    const ct = up.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) { res.status(415).end('not an image'); return; }
    const len = Number(up.headers.get('content-length') || 0);
    if (len && len > _IMG_MAX_BYTES) { res.status(413).end('too large'); return; }
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > _IMG_MAX_BYTES) { res.status(413).end('too large'); return; }
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).end(buf);
  } catch { res.status(502).end('fetch failed'); }
}

export default async function handler(req, res) {
  // Image-proxy branch first — runs before auth (an <img> tag can't send the app-password header).
  // Only triggers when a target param is present, so a normal GET /api/db-load is unaffected.
  if (req.method === 'GET') {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    if (qs.has('u') || qs.has('url')) return serveProxiedImage(req, res, qs);
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data, error } = await supabase
    .from('influencers')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    influencers: (data || []).map(toFrontend),
    total: data?.length || 0,
  });
}
