// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless persistent session and returns a liveURL the user opens
// in a new tab to log in manually. No Playwright needed here — the browser is
// controlled by the user, not the server.

import { checkAuth } from './_auth.js';

const TOKEN = process.env.BROWSERLESS_TOKEN;

const LOGIN_URLS = {
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok:    'https://www.tiktok.com/login/phone-or-email/email',
  x:         'https://x.com/i/flow/login',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;
  if (!TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });

  const { platform } = req.body || {};
  if (!platform || !LOGIN_URLS[platform]) {
    return res.status(400).json({ error: 'platform must be instagram, tiktok, or x' });
  }

  try {
    // Create a persistent Browserless session (10-minute TTL)
    const sessionResp = await fetch(
      `https://production-lon.browserless.io/session?token=${TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600000 }) }
    );
    if (!sessionResp.ok) {
      const text = await sessionResp.text();
      return res.status(502).json({ error: `Browserless error: ${text.slice(0, 200)}` });
    }
    const session = await sessionResp.json();
    console.log('[browser-session] session created:', JSON.stringify(session).slice(0, 300));

    // liveURL is the interactive browser the user opens — append the login URL so it navigates there
    const baseURL = session.liveURL || session.live_url || session.url;
    if (!baseURL) {
      return res.status(502).json({ error: 'Browserless did not return a liveURL', session });
    }

    // Encode the login URL as a destination for the live viewer
    const loginDest = encodeURIComponent(LOGIN_URLS[platform]);
    const liveURL = `${baseURL}&url=${loginDest}`;

    return res.status(200).json({ liveURL, sessionId: session.id || session.sessionId });
  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
