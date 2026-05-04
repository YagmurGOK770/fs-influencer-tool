// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless persistent session, uses BrowserQL to navigate to the
// login page, then returns the liveURL for the user to interact with.

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
    // Step 1: Create a persistent session (10-minute TTL)
    const sessionResp = await fetch(
      `https://production-lon.browserless.io/session?token=${TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600000 }) }
    );
    const rawText = await sessionResp.text();
    console.log('[browser-session] session response:', rawText.slice(0, 400));

    if (!sessionResp.ok) {
      return res.status(502).json({ error: `Browserless session error (${sessionResp.status}): ${rawText.slice(0, 200)}` });
    }

    let session;
    try { session = JSON.parse(rawText); }
    catch (e) { return res.status(502).json({ error: `Non-JSON from Browserless: ${rawText.slice(0, 200)}` }); }

    const sessionId = session.id;
    if (!sessionId) {
      return res.status(502).json({ error: 'No session id returned', session });
    }

    // Step 2: Use BrowserQL to navigate the session to the login page
    const loginUrl = LOGIN_URLS[platform];
    const bqlQuery = `
      mutation Navigate {
        goto(url: "${loginUrl}", waitUntil: domContentLoaded) {
          status
        }
      }
    `;
    const bqlResp = await fetch(
      `https://production-lon.browserless.io/chromium/bql?token=${TOKEN}&sessionId=${sessionId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: bqlQuery }),
      }
    );
    const bqlText = await bqlResp.text();
    console.log('[browser-session] BQL navigate response:', bqlText.slice(0, 300));
    // Don't fail if BQL navigation fails — live URL still works, user can navigate manually

    const liveURL = `https://production-lon.browserless.io/live/?i=${sessionId}&token=${TOKEN}`;
    return res.status(200).json({ liveURL, sessionId });

  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
