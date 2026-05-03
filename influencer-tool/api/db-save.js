// POST /api/db-save
// Body: { influencers: [...] }
// Upserts each influencer by handle, writes snapshots for any changed fields.

import { createClient } from '@supabase/supabase-js';
import { checkAuth, requireApiKey } from './_auth.js';

const TRACKED_FIELDS = [
  'name', 'platform', 'ig_handle', 'ig_followers',
  'tt_handle', 'tt_followers', 'yt_handle', 'yt_followers',
  'x_handle', 'x_followers', 'followers',
  'content_labels', 'who_they_are', 'what_they_post',
  'tone_style', 'target_audience', 'why_follow', 'found_via',
  'niche', 'location', 'bucket'
];

function toRow(inf) {
  return {
    handle:         (inf.handle || '').toLowerCase().trim(),
    name:           inf.name          || null,
    platform:       inf.platform      || null,
    ig_handle:      inf.igHandle      || null,
    ig_followers:   inf.igFollowers   || null,
    tt_handle:      inf.ttHandle      || null,
    tt_followers:   inf.ttFollowers   || null,
    yt_handle:      inf.ytHandle      || null,
    yt_followers:   inf.ytFollowers   || null,
    x_handle:       inf.xHandle       || null,
    x_followers:    inf.xFollowers    || null,
    followers:      inf.followers     || null,
    content_labels: inf.contentLabels || null,
    who_they_are:   inf.whoTheyAre    || null,
    what_they_post: inf.whatTheyPost  || null,
    tone_style:     inf.toneStyle     || null,
    target_audience:inf.targetAudience|| null,
    why_follow:     inf.whyFollow     || null,
    found_via:      inf.foundVia      || null,
    niche:          inf.niche         || null,
    location:       inf.location      || null,
    bucket:         inf.bucket        || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { influencers } = req.body || {};
  if (!Array.isArray(influencers) || influencers.length === 0) {
    return res.status(400).json({ error: 'influencers array is required' });
  }

  const saved = [];
  const snapshots = [];
  const errors = [];

  for (const inf of influencers) {
    const row = toRow(inf);
    if (!row.handle) continue;

    // Fetch existing record to diff against
    const { data: existing } = await supabase
      .from('influencers')
      .select('*')
      .eq('handle', row.handle)
      .maybeSingle();

    // Upsert
    const { data: upserted, error } = await supabase
      .from('influencers')
      .upsert(row, { onConflict: 'handle' })
      .select('id, handle')
      .single();

    if (error) {
      errors.push({ handle: row.handle, error: error.message });
      continue;
    }

    saved.push(row.handle);

    // Diff and write snapshots for changed fields
    if (existing) {
      for (const field of TRACKED_FIELDS) {
        const oldVal = existing[field] ?? null;
        const newVal = row[field] ?? null;
        if (oldVal !== newVal) {
          snapshots.push({
            influencer_id: upserted.id,
            handle: row.handle,
            field_name: field,
            old_value: oldVal,
            new_value: newVal,
          });
        }
      }
    }
  }

  if (snapshots.length > 0) {
    await supabase.from('influencer_snapshots').insert(snapshots);
  }

  return res.status(200).json({
    saved: saved.length,
    snapshots: snapshots.length,
    errors,
  });
}
