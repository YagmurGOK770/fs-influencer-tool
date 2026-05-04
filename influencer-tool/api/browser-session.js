// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless persistent session and returns the liveURL with the
// login page pre-loaded via the startingUrl parameter.

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
    // Create a persistent session (10-minute TTL)
    const sessionResp = await fetch(
      `https://production-lon.browserless.io/session?token=${TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600000 }) }
    );
    const rawText = await sessionResp.text();
    console.log('[browser-session] session response:', rawText.slice(0, 500));

    if (!sessionResp.ok) {
      return res.status(502).json({ error: `Browserless session error (${sessionResp.status}): ${rawText.slice(0, 200)}` });
    }

    let session;
    try { session = JSON.parse(rawText); }
    catch (e) { return res.status(502).json({ error: `Non-JSON from Browserless: ${rawText.slice(0, 200)}` }); }

    console.log('[browser-session] session keys:', Object.keys(session).join(', '));

    const sessionId = session.id;
    if (!sessionId) {
      return res.status(502).json({ error: 'No session id returned', raw: rawText.slice(0, 300) });
    }

    // Build the live viewer URL with startingUrl so the browser opens directly on the login page
    const loginUrl = encodeURIComponent(LOGIN_URLS[platform]);
    const liveURL = `https://production-lon.browserless.io/live/?i=${sessionId}&token=${TOKEN}&startingUrl=${loginUrl}`;

    console.log('[browser-session] liveURL:', liveURL.slice(0, 200));
    return res.status(200).json({ liveURL, sessionId });

  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
