// POST /api/save-session
// Body: { platform: 'instagram'|'tiktok'|'x', cookies: [{name, value, domain, path?}] }
//   OR  { platform, sessionId } — convenience: just paste the sessionid cookie value for Instagram
// Stores the cookies in Supabase so future scrapes skip the login flow.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

// Default cookie shape per platform — only the session cookie name + domain
const DEFAULTS = {
  instagram: { name: 'sessionid', domain: '.instagram.com', path: '/' },
  tiktok:    { name: 'sessionid', domain: '.tiktok.com',    path: '/' },
  x:         { name: 'auth_token', domain: '.x.com',        path: '/' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const { platform, cookies, sessionId } = req.body || {};
  if (!platform || !DEFAULTS[platform]) {
    return res.status(400).json({ error: 'Invalid platform. Must be instagram, tiktok or x.' });
  }

  let cookieList;
  if (Array.isArray(cookies) && cookies.length) {
    cookieList = cookies;
  } else if (sessionId) {
    cookieList = [{ ...DEFAULTS[platform], value: sessionId, secure: true, httpOnly: true, sameSite: 'Lax' }];
  } else {
    return res.status(400).json({ error: 'Provide either cookies[] or sessionId' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase
    .from('platform_sessions')
    .upsert({ platform, cookies: cookieList, updated_at: new Date().toISOString() }, { onConflict: 'platform' });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, platform, cookieCount: cookieList.length });
}
