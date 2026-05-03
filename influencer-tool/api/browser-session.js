// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'youtube' | 'x' }
// Creates a Browserless cloud session, navigates to the platform login page,
// returns { sessionId, liveURL, connectURL } for the client to embed and connect.

import { checkAuth } from './_auth.js';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const BROWSERLESS_HOST = 'production-lon.browserless.io';

const LOGIN_URLS = {
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok:    'https://www.tiktok.com/login',
  youtube:   'https://accounts.google.com/signin',
  x:         'https://x.com/i/flow/login',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  if (!BROWSERLESS_TOKEN) {
    return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });
  }

  const { platform } = req.body || {};
  if (!platform || !LOGIN_URLS[platform]) {
    return res.status(400).json({ error: 'Invalid platform. Must be instagram, tiktok, youtube or x.' });
  }

  // Create a Browserless session via the /session endpoint
  let sessionRaw, sessionText;
  try {
    const sessionResp = await fetch(
      `https://${BROWSERLESS_HOST}/session?token=${BROWSERLESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 900000 }),
      }
    );
    sessionText = await sessionResp.text();
    if (!sessionResp.ok) {
      return res.status(502).json({ error: `Browserless /session failed (${sessionResp.status}): ${sessionText}` });
    }
    sessionRaw = JSON.parse(sessionText);
  } catch (e) {
    return res.status(502).json({ error: `Browserless request error: ${e.message}`, raw: sessionText });
  }

  // Browserless v2 session response shape: { id, connect, liveURL } or similar
  const connectURL = sessionRaw.connect || sessionRaw.webSocketDebuggerUrl || sessionRaw.wsEndpoint;
  const sessionId  = sessionRaw.id || sessionRaw.sessionId;
  // liveURL may be returned directly, or we construct it
  const liveURL = sessionRaw.liveURL
    || `https://${BROWSERLESS_HOST}/live/?i=${sessionId}&token=${BROWSERLESS_TOKEN}`;

  if (!connectURL) {
    return res.status(502).json({ error: 'Browserless did not return a WebSocket URL', raw: sessionRaw });
  }

  // Navigate to the platform login page so it's ready when the user opens the iframe
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connect({ wsEndpoint: connectURL });
    const page = await browser.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Leave browser open — session stays live for user interaction
  } catch (navErr) {
    console.warn('[browser-session] navigation warning:', navErr.message);
    // Non-fatal — user can navigate manually in the iframe
  }

  return res.status(200).json({ sessionId, liveURL, connectURL, debug: { keys: Object.keys(sessionRaw) } });
}
