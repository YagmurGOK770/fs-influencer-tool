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
    const sessionKeys = Object.keys(session);
    console.log('[browser-session] session response keys:', sessionKeys.join(', '));
    console.log('[browser-session] session response:', JSON.stringify(session).slice(0, 500));

    // Browserless Sessions API returns: { id, connect (wsEndpoint), cloudEndpointId, ttl, stop, browserQL }
    // The live viewer URL is constructed from the session id:
    // https://production-lon.browserless.io/live/?i=<sessionId>
    const sessionId = session.id;
    if (!sessionId) {
      return res.status(502).json({ error: 'Browserless did not return a session id', receivedKeys: sessionKeys });
    }

    const loginDest = encodeURIComponent(LOGIN_URLS[platform]);
    const liveURL = `https://production-lon.browserless.io/live/?i=${sessionId}&url=${loginDest}`;

    return res.status(200).json({ liveURL, sessionId });
  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
