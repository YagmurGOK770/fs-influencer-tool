// POST /api/browser-session
// Body: { platform: 'instagram' | 'tiktok' | 'x' }
// Creates a Browserless persistent session, navigates to the login page via
// Playwright, then calls Browserless.liveURL() via CDP to get the shareable
// live viewer URL.

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

  let browser;
  try {
    // Step 1: Create a persistent session (10-minute TTL)
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
    const { id: sessionId, connect: wsEndpoint } = session;

    if (!sessionId || !wsEndpoint) {
      return res.status(502).json({ error: 'Missing id or connect in session response', keys: Object.keys(session) });
    }

    // Step 2: Connect via Playwright and navigate to the login page
    browser = await chromium.connectOverCDP(wsEndpoint);
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();
    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    console.log('[browser-session] navigating to', LOGIN_URLS[platform]);
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[browser-session] navigation done, url:', page.url());

    // Step 3: Get a live viewer URL via CDP Browserless.liveURL
    const cdpSession = await page.context().newCDPSession(page);
    const { liveURL } = await cdpSession.send('Browserless.liveURL', {
      timeout: 600000,
      interactable: true,
      resizable: true,
    });

    console.log('[browser-session] liveURL:', liveURL?.slice(0, 100));
    return res.status(200).json({ liveURL, sessionId });

  } catch (err) {
    console.error('[browser-session] error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    // Disconnect (not close) so the Browserless session stays alive for the user to log in
    if (browser) {
      try { browser.disconnect(); } catch (_) {}
    }
  }
}
