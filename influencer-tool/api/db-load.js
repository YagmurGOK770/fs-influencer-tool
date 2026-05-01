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
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

export default async function handler(req, res) {
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
