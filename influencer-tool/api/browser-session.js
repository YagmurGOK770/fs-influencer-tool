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
    const rawText = await sessionResp.text();
    console.log('[browser-session] raw response:', rawText.slice(0, 400));

    if (!sessionResp.ok) {
      return res.status(502).json({ error: `Browserless error (${sessionResp.status}): ${rawText.slice(0, 200)}` });
    }

    let session;
    try {
      session = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: `Browserless returned non-JSON: ${rawText.slice(0, 200)}` });
    }
    console.log('[browser-session] session keys:', Object.keys(session).join(', '));

    // session keys: { id, connect (wsEndpoint), cloudEndpointId, ttl, stop, browserQL }
    const sessionId = session.id;
    const connectURL = session.connect; // e.g. "wss://production-lon.browserless.io/playwright/chromium?..."

    if (!sessionId) {
      return res.status(502).json({ error: 'Browserless session missing id', session });
    }

    // Use the generic Playwright endpoint with the token — session's connectURL may need
    // the token appended if it isn't already included
    const wsEndpoint = connectURL
      ? (connectURL.includes('token=') ? connectURL : `${connectURL}&token=${TOKEN}`)
      : `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

    console.log('[browser-session] connecting to:', wsEndpoint.replace(TOKEN, 'TOKEN'));

    const browser = await chromium.connect({ wsEndpoint });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Do NOT close — session stays live for the user

    const liveURL = `https://production-lon.browserless.io/live/?i=${sessionId}&token=${TOKEN}`;
    return res.status(200).json({ liveURL, sessionId });

  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
