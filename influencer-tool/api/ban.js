// GET  /api/ban          — list all banned handles
// POST /api/ban          — ban handles { handles: string[], reason?: string }
// DELETE /api/ban        — unban handles { handles: string[] }

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const db = supabase();

  if (req.method === 'GET') {
    const { data, error } = await db
      .from('banned_influencers')
      .select('handle, reason, banned_at')
      .order('banned_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ banned: data || [] });
  }

  if (req.method === 'POST') {
    const { handles, reason } = req.body || {};
    if (!Array.isArray(handles) || !handles.length)
      return res.status(400).json({ error: 'handles array required' });

    const rows = handles.map(h => ({
      handle: h.toLowerCase().trim(),
      reason: reason || null,
    }));

    const { error } = await db
      .from('banned_influencers')
      .upsert(rows, { onConflict: 'handle' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ banned: rows.length });
  }

  if (req.method === 'DELETE') {
    const { handles } = req.body || {};
    if (!Array.isArray(handles) || !handles.length)
      return res.status(400).json({ error: 'handles array required' });

    const { error } = await db
      .from('banned_influencers')
      .delete()
      .in('handle', handles.map(h => h.toLowerCase().trim()));
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ unbanned: handles.length });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
