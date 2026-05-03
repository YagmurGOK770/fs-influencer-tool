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

  // Create a persistent Browserless session (15 min TTL)
  const sessionResp = await fetch(
    `https://${BROWSERLESS_HOST}/session?token=${BROWSERLESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 900000 }),
    }
  );

  if (!sessionResp.ok) {
    const text = await sessionResp.text();
    return res.status(502).json({ error: `Browserless session failed: ${sessionResp.status} ${text}` });
  }

  const session = await sessionResp.json();
  const connectURL = session.connect || session.webSocketDebuggerUrl;
  const sessionId  = session.sessionId || session.id;

  if (!connectURL) {
    return res.status(502).json({ error: 'Browserless did not return a connect URL', raw: session });
  }

  // Navigate to the login page via CDP so the iframe shows it immediately
  // Use the /json/new endpoint to open a page, then navigate
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connect({ wsEndpoint: connectURL });
    const page = await browser.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Don't close the browser — session stays live for user interaction
  } catch (navErr) {
    // Navigation failure is non-fatal — live URL will still show a browser the user can navigate
    console.warn('[browser-session] navigation warning:', navErr.message);
  }

  // Generate the live viewer URL
  const liveURL = `https://${BROWSERLESS_HOST}/live/?i=${sessionId}&token=${BROWSERLESS_TOKEN}`;

  return res.status(200).json({ sessionId, liveURL, connectURL });
}
