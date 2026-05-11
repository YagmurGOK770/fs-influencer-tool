// POST /api/db-save
// Body: { influencers: [...] }
// Upserts each influencer by handle, writes snapshots for any changed fields.
// For brand-new influencers, writes an initial "first seen" snapshot (old_value = null).
// Probes actual table columns on first call so unknown columns never break saves.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

const TRACKED_FIELDS = [
  'name', 'platform', 'ig_handle', 'ig_followers',
  'tt_handle', 'tt_followers', 'yt_handle', 'yt_followers',
  'x_handle', 'x_followers', 'followers',
  'content_labels', 'who_they_are', 'what_they_post',
  'tone_style', 'target_audience', 'why_follow', 'found_via',
  'niche', 'location', 'bucket', 'is_verified', 'post_count',
  'follower_verified',
];

function toRow(inf) {
  return {
    handle:          (inf.handle || '').toLowerCase().trim(),
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
    tone_style:      inf.toneStyle      || null,
    target_audience: inf.targetAudience || null,
    why_follow:      inf.whyFollow      || null,
    found_via:       inf.foundVia       || null,
    niche:           inf.niche          || null,
    location:        inf.location       || null,
    bucket:          inf.bucket         || null,
    is_verified:      inf.isVerified      ?? null,
    post_count:       inf.postCount       || null,
    follower_verified: inf.followerVerified ? true : null,
  };
}

// Cache known columns across warm invocations
let knownColumns = null;

async function getKnownColumns(supabase) {
  if (knownColumns) return knownColumns;
  const { data, error } = await supabase.from('influencers').select('*').limit(1);
  if (!error && data && data.length > 0) {
    knownColumns = new Set(Object.keys(data[0]));
  }
  return knownColumns;
}

function filterRow(row, cols) {
  if (!cols) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (cols.has(k)) out[k] = v;
  }
  return out;
}

// ── BrightData save (merged here to stay under Vercel 12-function limit) ──
function bdToRow(p) {
  return {
    handle:          (p.handle || '').toLowerCase().trim(),
    platform:        p.rawPlatform || p.platform || '',
    full_name:       p.fullName    || null,
    followers:       p.followers   || null,
    bio:             p.bio         || null,
    post_count:      p.postCount   || null,
    is_verified:     p.isVerified  ?? null,
    engagement_rate: p.engagementRate != null ? String(p.engagementRate) : null,
    location:        p.location    || null,
    country:         p.country     || null,
    likes:           p.likes       || null,
    profile_url:     p.profileUrl  || null,
    raw_platform:    p.rawPlatform || null,
    fetched_at:      new Date().toISOString(),
  };
}

async function handleBrightDataSave(req, res, supabase) {
  const { profiles } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length)
    return res.status(400).json({ error: 'profiles[] is required' });
  const rows = profiles.map(bdToRow).filter(r => r.handle && r.platform);
  if (!rows.length) return res.status(400).json({ error: 'No valid profiles to save' });
  const { error, data } = await supabase
    .from('brightdata_profiles')
    .upsert(rows, { onConflict: 'handle,platform' })
    .select('handle, platform');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ saved: data?.length ?? rows.length });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  if ((req.body || {}).action === 'brightdata') {
    return handleBrightDataSave(req, res, supabase);
  }

  const { influencers } = req.body || {};
  if (!Array.isArray(influencers) || influencers.length === 0) {
    return res.status(400).json({ error: 'influencers array is required' });
  }

  const cols = await getKnownColumns(supabase);

  const saved = [];
  const snapshots = [];
  const errors = [];

  // Use a single timestamp for this whole batch so all snapshots from one save
  // are grouped together as one "run" in the changes view.
  const runAt = new Date().toISOString();

  for (const inf of influencers) {
    const fullRow = toRow(inf);
    if (!fullRow.handle) continue;

    const row = filterRow(fullRow, cols);

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
      knownColumns = null;
      continue;
    }

    saved.push(row.handle);

    if (existing) {
      // Existing record — diff and write snapshots for changed fields only
      for (const field of TRACKED_FIELDS) {
        if (cols && !cols.has(field)) continue;
        const oldVal = existing[field] ?? null;
        const newVal = row[field] ?? null;
        if (oldVal !== newVal) {
          snapshots.push({
            influencer_id: upserted.id,
            handle: row.handle,
            field_name: field,
            old_value: oldVal,
            new_value: newVal,
            run_at: runAt,
          });
        }
      }
    } else {
      // Brand-new influencer — write a "first seen" snapshot for every non-null field
      // so this discovery appears in the changes log with old_value = null.
      for (const field of TRACKED_FIELDS) {
        if (cols && !cols.has(field)) continue;
        const newVal = row[field] ?? null;
        if (newVal !== null) {
          snapshots.push({
            influencer_id: upserted.id,
            handle: row.handle,
            field_name: field,
            old_value: null,
            new_value: newVal,
            run_at: runAt,
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
