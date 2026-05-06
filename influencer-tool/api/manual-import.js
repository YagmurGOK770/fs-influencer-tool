// POST /api/manual-import
// Body: { influencers: [...] }
// Upserts into manual_influencers table (same shape as influencers).
// Primary key is handle (lowercased). Existing rows are overwritten.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

function toRow(inf) {
  return {
    handle:          (inf.handle || inf.igHandle || inf.ttHandle || inf.ytHandle || inf.xHandle || '').toLowerCase().trim(),
    name:            inf.name           || null,
    platform:        inf.platform       || null,
    ig_handle:       inf.igHandle       || null,
    ig_followers:    inf.igFollowers    || null,
    tt_handle:       inf.ttHandle       || null,
    tt_followers:    inf.ttFollowers    || null,
    yt_handle:       inf.ytHandle       || null,
    yt_followers:    inf.ytFollowers    || null,
    x_handle:        inf.xHandle        || null,
    x_followers:     inf.xFollowers     || null,
    followers:       inf.followers      || null,
    content_labels:  inf.contentLabels  || null,
    who_they_are:    inf.whoTheyAre     || null,
    what_they_post:  inf.whatTheyPost   || null,
    niche:           inf.niche          || null,
    location:        inf.location       || null,
    bucket:          inf.bucket         || null,
    notes:           inf.notes          || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { influencers } = req.body || {};
  if (!Array.isArray(influencers) || !influencers.length) {
    return res.status(400).json({ error: 'influencers array is required' });
  }

  const rows = influencers.map(toRow).filter(r => r.handle);
  if (!rows.length) {
    return res.status(400).json({ error: 'No valid rows (every row needs at least a handle or platform handle)' });
  }

  const { error } = await supabase
    .from('manual_influencers')
    .upsert(rows, { onConflict: 'handle' });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ saved: rows.length });
}
