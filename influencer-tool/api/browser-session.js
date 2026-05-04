// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless live session, navigates to the platform login page,
// and returns a liveURL the frontend can open in a new tab for manual login.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';

const TOKEN = process.env.BROWSERLESS_TOKEN;
const WS_ENDPOINT = `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

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
    // Create a persistent Browserless session with 10-minute TTL
    const sessionResp = await fetch(
      `https://production-lon.browserless.io/session?token=${TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600000 }) }
    );
    if (!sessionResp.ok) {
      const text = await sessionResp.text();
      return res.status(502).json({ error: `Browserless session error: ${text.slice(0, 200)}` });
    }
    const session = await sessionResp.json();
    const { id: sessionId, liveURL, connectURL } = session;

    // Connect Playwright and navigate to login page so user lands there immediately
    const browser = await chromium.connect({ wsEndpoint: connectURL || WS_ENDPOINT });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Don't close — leave session live for manual login

    return res.status(200).json({ liveURL, sessionId });
  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
