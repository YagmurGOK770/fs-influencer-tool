// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless persistent session, navigates it to the platform login page
// via Playwright using the session's own connectURL, then returns the liveURL
// so the user can interact with it in a new tab.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';

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
    // session keys: { id, connect (wsEndpoint), cloudEndpointId, ttl, stop, browserQL }
    const { id: sessionId, connect: connectURL } = session;

    if (!sessionId || !connectURL) {
      return res.status(502).json({ error: 'Browserless session missing id or connect URL', session });
    }

    // Connect Playwright to this specific session and navigate to the login page
    // so the live viewer shows the login page immediately when the user opens it
    const browser = await chromium.connect({ wsEndpoint: connectURL });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Do NOT close the browser — session must stay open for the user to interact with

    const liveURL = `https://production-lon.browserless.io/live/?i=${sessionId}&token=${TOKEN}`;
    return res.status(200).json({ liveURL, sessionId });

  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
