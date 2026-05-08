// GET /api/search-history
// Returns recent search run logs + pre-aggregated stats for trend analysis.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: runs, error } = await supabase
    .from('search_run_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });

  // Aggregate by provider+model
  const byModel = {};
  for (const r of runs || []) {
    const key = `${r.provider}||${r.model}`;
    if (!byModel[key]) byModel[key] = { provider: r.provider, model: r.model, runs: 0, candidates: 0, newInSession: 0 };
    byModel[key].runs++;
    byModel[key].candidates    += r.candidates_found  || 0;
    byModel[key].newInSession  += r.new_in_session    || 0;
  }

  // Aggregate by platform
  const byPlatform = {};
  for (const r of runs || []) {
    const key = r.platform || 'unknown';
    if (!byPlatform[key]) byPlatform[key] = { platform: key, runs: 0, candidates: 0, newInSession: 0 };
    byPlatform[key].runs++;
    byPlatform[key].candidates   += r.candidates_found || 0;
    byPlatform[key].newInSession += r.new_in_session   || 0;
  }

  return res.status(200).json({
    runs:       runs || [],
    byModel:    Object.values(byModel).sort((a, b) => b.newInSession - a.newInSession),
    byPlatform: Object.values(byPlatform).sort((a, b) => b.newInSession - a.newInSession),
  });
}
