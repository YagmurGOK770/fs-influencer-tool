// GET /api/db-changes
// Returns influencers that have at least one change snapshot,
// each with their full snapshot history grouped by run_at date.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

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

  // Fetch all snapshots with influencer info, ordered by influencer then date
  const { data: snapshots, error } = await supabase
    .from('influencer_snapshots')
    .select(`
      id,
      handle,
      field_name,
      old_value,
      new_value,
      run_at,
      influencer_id,
      influencers (name, platform, ig_handle, tt_handle, followers)
    `)
    .order('handle', { ascending: true })
    .order('run_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  if (!snapshots || snapshots.length === 0) {
    return res.status(200).json({ influencers: [] });
  }

  // Group by handle → then by run_at (ISO date string truncated to minute for grouping)
  const byHandle = {};
  for (const s of snapshots) {
    if (!byHandle[s.handle]) {
      const inf = s.influencers || {};
      byHandle[s.handle] = {
        handle: s.handle,
        name: inf.name || s.handle,
        platform: inf.platform || '',
        igHandle: inf.ig_handle || '',
        ttHandle: inf.tt_handle || '',
        followers: inf.followers || '',
        runs: {}
      };
    }

    // Group changes within the same run (bucket by minute)
    const runKey = s.run_at ? s.run_at.slice(0, 16) : 'unknown';
    if (!byHandle[s.handle].runs[runKey]) {
      byHandle[s.handle].runs[runKey] = {
        runAt: s.run_at,
        changes: []
      };
    }

    byHandle[s.handle].runs[runKey].changes.push({
      field: s.field_name,
      oldValue: s.old_value,
      newValue: s.new_value
    });
  }

  // Convert to array, runs as sorted array (newest first)
  const influencers = Object.values(byHandle).map(inf => ({
    ...inf,
    runs: Object.values(inf.runs).sort((a, b) => new Date(b.runAt) - new Date(a.runAt))
  }));

  return res.status(200).json({ influencers, total: influencers.length });
}
