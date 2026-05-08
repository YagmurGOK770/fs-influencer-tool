// POST /api/log-search-run
// Logs one search combo result to search_run_logs for trend analysis.
// Body: { provider, model, platform, keyword, location, minFollowers, candidatesFound, newInSession }

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const {
    provider, model, platform, keyword, location,
    minFollowers, candidatesFound, newInSession,
  } = req.body || {};

  const { error } = await supabase.from('search_run_logs').insert({
    provider:          provider         || null,
    model:             model            || null,
    platform:          platform         || null,
    keyword:           keyword          || null,
    location:          location         || null,
    min_followers:     Number(minFollowers)    || 0,
    candidates_found:  Number(candidatesFound) || 0,
    new_in_session:    Number(newInSession)    || 0,
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
