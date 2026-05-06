// GET /api/db-changes
// Returns all influencers that have snapshots, grouped by run.
// Runs where every change has old_value = null are "first seen" entries.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

const TRACKED = new Set([
  'name', 'platform',
  'ig_handle', 'ig_followers',
  'tt_handle', 'tt_followers',
  'yt_handle', 'yt_followers',
  'x_handle', 'x_followers',
  'followers',
  'content_labels', 'who_they_are', 'what_they_post',
  'location',
]);

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
    return res.status(200).json({ influencers: [], total: 0 });
  }

  // Group by handle → run_at (to-the-second precision for batched saves)
  const byHandle = {};
  for (const s of snapshots) {
    if (!TRACKED.has(s.field_name)) continue;

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

    // Group by exact second — batched saves share the same run_at
    const runKey = s.run_at ? s.run_at.slice(0, 19) : 'unknown';
    if (!byHandle[s.handle].runs[runKey]) {
      byHandle[s.handle].runs[runKey] = {
        runAt: s.run_at,
        changes: []
      };
    }

    byHandle[s.handle].runs[runKey].changes.push({
      field: s.field_name,
      oldValue: s.old_value,
      newValue: s.new_value,
    });
  }

  // Convert to array; tag runs as "firstSeen" when all changes have null old_value
  const influencers = Object.values(byHandle)
    .map(inf => ({
      ...inf,
      runs: Object.values(inf.runs)
        .filter(r => r.changes.length > 0)
        .map(r => ({
          ...r,
          firstSeen: r.changes.every(c => c.oldValue === null),
        }))
        .sort((a, b) => new Date(b.runAt) - new Date(a.runAt))
    }))
    .filter(inf => inf.runs.length > 0)
    .sort((a, b) => {
      // Sort influencers by their most recent run date
      const aLatest = new Date(a.runs[0]?.runAt || 0);
      const bLatest = new Date(b.runs[0]?.runAt || 0);
      return bLatest - aLatest;
    });

  return res.status(200).json({ influencers, total: influencers.length });
}
