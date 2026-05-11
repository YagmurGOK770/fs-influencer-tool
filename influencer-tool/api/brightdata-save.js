// POST /api/brightdata-save
// Body: { profiles: [{ handle, platform, ...bdFields }] }
// Upserts enriched BrightData profile data into the brightdata_profiles table.
// This is intentionally separate from the influencers table so BD data never
// silently overwrites curated data — merging is a deliberate manual step.
//
// Required Supabase migration:
//   CREATE TABLE IF NOT EXISTS brightdata_profiles (
//     id            bigint generated always as identity primary key,
//     handle        text not null,
//     platform      text not null,
//     full_name     text,
//     followers     text,
//     bio           text,
//     post_count    text,
//     is_verified   boolean,
//     engagement_rate text,
//     location      text,
//     country       text,
//     likes         text,
//     profile_url   text,
//     raw_platform  text,
//     fetched_at    timestamptz not null default now(),
//     UNIQUE (handle, platform)
//   );

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

function toRow(p) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const { profiles } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length) {
    return res.status(400).json({ error: 'profiles[] is required' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const rows = profiles.map(toRow).filter(r => r.handle && r.platform);
  if (!rows.length) return res.status(400).json({ error: 'No valid profiles to save' });

  const { error, data } = await supabase
    .from('brightdata_profiles')
    .upsert(rows, { onConflict: 'handle,platform' })
    .select('handle, platform');

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ saved: data?.length ?? rows.length });
}
