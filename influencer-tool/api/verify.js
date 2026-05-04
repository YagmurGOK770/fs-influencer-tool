// POST /api/verify
// Body: { platform: 'instagram', handles: ['@user1', '@user2', ...] }
// Visits each profile via Browserless using the saved session cookie,
// returns live follower count + bio for each handle.
// Used to verify candidates that came from the Google/Claude search path.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.BROWSERLESS_TOKEN;
const WS_ENDPOINT = `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

const PROFILE_URL = {
  instagram: u => `https://www.instagram.com/${u}/`,
  tiktok:    u => `https://www.tiktok.com/@${u}`,
  x:         u => `https://x.com/${u}`,
};

const randDelay = (page, min, max) => page.waitForTimeout(min + Math.random() * (max - min));

async function loadSavedCookies(platform) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data } = await supabase.from('platform_sessions').select('cookies').eq('platform', platform).maybeSingle();
  return data?.cookies || null;
}

async function applyCookies(context, cookies) {
  const cleaned = cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain || '', path: c.path || '/',
    secure: c.secure !== false, httpOnly: c.httpOnly !== false, sameSite: c.sameSite || 'Lax',
  })).filter(c => c.name && c.value && c.domain);
  if (cleaned.length) await context.addCookies(cleaned);
}

function stripAt(handle) {
  return String(handle || '').replace(/^@/, '').trim();
}

async function verifyInstagram(page, username) {
  await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await randDelay(page, 1500, 3000);

  // Skip if redirected to login / error / challenge
  const url = page.url();
  if (!url.includes(`/${username}`) || url.includes('/accounts/login') || url.includes('/challenge/')) {
    return { ok: false, reason: 'redirected', finalUrl: url };
  }

  // Occasional human-like scroll
  if (Math.random() < 0.3) {
    await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 300));
    await randDelay(page, 600, 1300);
  }

  const data = await page.evaluate(() => {
    let followers = '';
    const followerLi = document.querySelector('header section ul li:nth-child(2)');
    if (followerLi) {
      const titleSpan = followerLi.querySelector('span[title]');
      if (titleSpan) {
        followers = titleSpan.getAttribute('title').replace(/,/g, '');
      } else {
        const spans = followerLi.querySelectorAll('span span span, span span, span');
        for (const s of spans) {
          const t = s.textContent.trim();
          if (/^[\d.,]+[KkMm]?$/.test(t)) { followers = t; break; }
        }
      }
    }
    if (!followers) {
      const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const m = meta.match(/([\d,.]+[KkMmBb]?)\s*Followers?/i);
      if (m) followers = m[1];
    }
    const bio = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
      || document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const isPrivate = !!document.querySelector('h2')?.textContent?.match(/Private|This Account is Private/i);
    return { followers, bio, isPrivate };
  });

  return { ok: true, ...data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;
  if (!TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });

  const { platform, handles } = req.body || {};
  if (platform !== 'instagram') {
    return res.status(400).json({ error: 'Only instagram is supported right now' });
  }
  if (!Array.isArray(handles) || !handles.length) {
    return res.status(400).json({ error: 'handles[] is required' });
  }

  const cookies = await loadSavedCookies(platform);
  if (!cookies || !cookies.length) {
    return res.status(400).json({ error: 'cookie_missing', message: 'No saved Instagram session — paste your sessionid via the 🔑 button first' });
  }

  let browser, context;
  try {
    browser = await chromium.connectOverCDP(WS_ENDPOINT);
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    await applyCookies(context, cookies);
    const page = await context.newPage();

    // Quick session check — visit IG home, if we get bounced to login, the cookie is dead
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (page.url().includes('/accounts/login') || page.url().includes('/challenge/')) {
      return res.status(401).json({ error: 'cookie_expired', message: 'Saved Instagram cookie expired — paste a fresh one via 🔑' });
    }
    await randDelay(page, 1500, 3000);

    const results = {};
    for (let i = 0; i < handles.length; i++) {
      const username = stripAt(handles[i]);
      if (!username) continue;

      // Human-paced gap between profile visits
      if (i > 0) {
        await randDelay(page, 3000, 6500);
        await page.mouse.move(100 + Math.random() * 800, 100 + Math.random() * 500, { steps: 6 });
      }

      // Bail out if browser died mid-loop — return what we have
      if (page.isClosed()) {
        console.log('[verify] page closed mid-loop, returning partial results');
        break;
      }

      try {
        const result = await verifyInstagram(page, username);
        results[handles[i]] = result;
        console.log(`[verify] ${username}: followers=${result.followers || '—'} ok=${result.ok}`);
      } catch (e) {
        console.log(`[verify] ${username} failed: ${e.message.slice(0, 100)}`);
        results[handles[i]] = { ok: false, reason: e.message.slice(0, 100) };
        if (e.message.includes('closed') || e.message.includes('Target')) break;
      }
    }

    return res.status(200).json({ results });

  } catch (err) {
    console.error('[verify] error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (context) try { await context.close(); } catch (_) {}
    if (browser) try { await browser.close(); } catch (_) {}
  }
}
