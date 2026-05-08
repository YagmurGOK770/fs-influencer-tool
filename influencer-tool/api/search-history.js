// GET   /api/search-history — returns recent logs + aggregated trend stats
// POST  /api/search-history — logs one search session result, returns { ok, id }
// PATCH /api/search-history — updates accepted/banned counts for a session log record

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── POST: log one session run ─────────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      provider, model, platform, keyword, location,
      minFollowers, candidatesFound, newInSession,
    } = req.body || {};

    const { data, error } = await supabase.from('search_run_logs').insert({
      provider:         provider         || null,
      model:            model            || null,
      platform:         platform         || null,
      keyword:          keyword          || null,
      location:         location         || null,
      min_followers:    Number(minFollowers)    || 0,
      candidates_found: Number(candidatesFound) || 0,
      new_in_session:   Number(newInSession)    || 0,
    }).select('id').single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id: data.id });
  }

  // ── PATCH: update accepted / banned counts for an existing record ─────────
  if (req.method === 'PATCH') {
    const { id, accepted, banned } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const updates = {};
    if (accepted !== undefined) updates.accepted = Number(accepted);
    if (banned   !== undefined) updates.banned   = Number(banned);
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no fields to update' });

    const { error } = await supabase.from('search_run_logs').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── GET: return logs + aggregated stats ───────────────────────────────────
  if (req.method === 'GET') {
    const { data: runs, error } = await supabase
      .from('search_run_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const byModel = {};
    for (const r of runs || []) {
      const key = `${r.provider}||${r.model}`;
      if (!byModel[key]) byModel[key] = { provider: r.provider, model: r.model, runs: 0, candidates: 0, newInSession: 0, accepted: 0, banned: 0 };
      byModel[key].runs++;
      byModel[key].candidates   += r.candidates_found || 0;
      byModel[key].newInSession += r.new_in_session   || 0;
      byModel[key].accepted     += r.accepted         || 0;
      byModel[key].banned       += r.banned           || 0;
    }

    const byPlatform = {};
    for (const r of runs || []) {
      const key = r.platform || 'unknown';
      if (!byPlatform[key]) byPlatform[key] = { platform: key, runs: 0, candidates: 0, newInSession: 0, accepted: 0, banned: 0 };
      byPlatform[key].runs++;
      byPlatform[key].candidates   += r.candidates_found || 0;
      byPlatform[key].newInSession += r.new_in_session   || 0;
      byPlatform[key].accepted     += r.accepted         || 0;
      byPlatform[key].banned       += r.banned           || 0;
    }

    return res.status(200).json({
      runs:       runs || [],
      byModel:    Object.values(byModel).sort((a, b) => b.newInSession - a.newInSession),
      byPlatform: Object.values(byPlatform).sort((a, b) => b.newInSession - a.newInSession),
    });
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
