// POST /api/browser-scrape
// Body: { platform, keyword, maxResults }
// Connects to Browserless BaaS V2 via Playwright, logs in with stored credentials,
// scrapes the platform natively, returns { influencers: [] }.
//
// Required Vercel env vars:
//   BROWSERLESS_TOKEN  — your Browserless API token
//   IG_USER / IG_PASS  — Instagram scraping account
//   TT_USER / TT_PASS  — TikTok scraping account
//   X_USER  / X_PASS   — X scraping account
// YouTube needs no login.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.BROWSERLESS_TOKEN;
// BaaS V2 Playwright endpoint — must include /playwright/chromium path
const WS_ENDPOINT = `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

async function loadSavedCookies(platform) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data } = await supabase.from('platform_sessions').select('cookies').eq('platform', platform).maybeSingle();
  return data?.cookies || null;
}

async function applyCookies(context, cookies) {
  // Playwright requires {name, value, domain, path}
  const cleaned = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: c.httpOnly !== false,
    sameSite: c.sameSite || 'Lax',
  })).filter(c => c.name && c.value && c.domain);
  if (cleaned.length) await context.addCookies(cleaned);
}

function normaliseFollowers(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).replace(/,/g, '').trim();
  const match = s.match(/^([\d.]+)\s*([KkMmBb])?/);
  if (!match) return s;
  let num = parseFloat(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') num *= 1_000;
  if (suffix === 'm') num *= 1_000_000;
  if (suffix === 'b') num *= 1_000_000_000;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(num));
}

// ── Login helpers ───────────────────────────────────────────────────────────

async function loginInstagram(page) {
  const user = process.env.IG_USER;
  const pass = process.env.IG_PASS;
  if (!user || !pass) throw new Error('IG_USER / IG_PASS not set in environment');

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Dismiss EU cookie banner if present
  await page.locator('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies"), button:has-text("Only allow essential cookies")').first().click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // If Instagram shows a saved-profile chooser, click "Use another profile" to reach the login form
  await page.locator('div[role="button"]:has-text("Use another profile"), button:has-text("Use another profile"), a:has-text("Use another profile")').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Find the username field using multiple fallback selectors
  // Instagram's modern login uses placeholder "Mobile number, username or email"
  const userSelectors = [
    'input[name="username"]',
    'input[aria-label*="username" i]',
    'input[aria-label*="email" i]',
    'input[autocomplete="username"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="Mobile" i]',
    'form input[type="text"]',
    'form input:not([type="password"]):not([type="hidden"]):not([type="submit"])',
  ];
  let userField = null;
  for (const sel of userSelectors) {
    userField = await page.waitForSelector(sel, { timeout: 4000, state: 'visible' }).catch(() => null);
    if (userField) break;
  }
  if (!userField) {
    const url = page.url();
    const title = await page.title();
    const inputCount = await page.locator('input').count();
    throw new Error(`Instagram username field not found. URL: ${url}, title: ${title}, inputs on page: ${inputCount}`);
  }

  await userField.click();
  await userField.fill(user);
  await page.waitForTimeout(300);
  await page.fill('input[type="password"]', pass);
  await page.waitForTimeout(300);

  // Submit — Instagram uses a div[role="button"] in newer versions, not a real <button>
  const submitSelectors = [
    'button[type="submit"]:not(:has-text("Facebook"))',
    'div[role="button"]:has-text("Log in"):not(:has-text("Facebook"))',
    'button:has-text("Log in"):not(:has-text("Facebook"))',
    '[type="submit"]',
  ];
  let clicked = false;
  for (const sel of submitSelectors) {
    const ok = await page.locator(sel).first().click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (ok) { clicked = true; break; }
  }
  if (!clicked) {
    // Last resort — press Enter inside the password field
    await page.locator('input[type="password"]').first().press('Enter').catch(() => {});
  }

  // Wait for navigation away from login or for any post-login element
  await Promise.race([
    page.waitForURL(url => !url.includes('/accounts/login'), { timeout: 20000 }),
    page.waitForSelector('svg[aria-label="Home"], a[href="/"]', { timeout: 20000 })
  ]).catch(() => {});

  // Dismiss "Save login info" and "Turn on notifications" prompts
  for (let i = 0; i < 2; i++) {
    await page.locator('button:has-text("Not Now"), button:has-text("Not now")').first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
}

async function loginTikTok(page) {
  const user = process.env.TT_USER;
  const pass = process.env.TT_PASS;
  if (!user || !pass) throw new Error('TT_USER / TT_PASS not set in environment');

  await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[name="username"], input[placeholder*="mail"], input[type="text"]', { timeout: 10000 });
  await page.fill('input[name="username"], input[placeholder*="mail"], input[type="text"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"], button:has-text("Log in")');
  await page.waitForURL(url => !url.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function loginX(page) {
  const user = process.env.X_USER;
  const pass = process.env.X_PASS;
  if (!user || !pass) throw new Error('X_USER / X_PASS not set in environment');

  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', user);
  await page.click('button:has-text("Next")');
  await page.waitForSelector('input[name="password"]', { timeout: 10000 });
  await page.fill('input[name="password"]', pass);
  await page.click('button[data-testid="LoginForm_Login_Button"]');
  await page.waitForURL(url => url.includes('x.com/home') || !url.includes('login'), { timeout: 15000 });
  await page.waitForTimeout(1500);
}

// ── Per-platform scrapers ───────────────────────────────────────────────────

async function scrapeYouTube(page, keyword, maxResults) {
  const q = encodeURIComponent(keyword + ' food london');
  await page.goto(`https://www.youtube.com/results?search_query=${q}&sp=EgIQAg%3D%3D`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('button:has-text("Accept all")').click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.waitForSelector('ytd-channel-renderer', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => window.scrollBy(0, 1200));
  await page.waitForTimeout(2000);

  return page.evaluate((max) =>
    Array.from(document.querySelectorAll('ytd-channel-renderer')).slice(0, max).map(c => ({
      handle:    (c.querySelector('#channel-handle, yt-formatted-string#channel-handle')?.textContent || '').trim(),
      name:      (c.querySelector('#channel-title')?.textContent || '').trim(),
      followers: (c.querySelector('#subscribers')?.textContent || '').replace(/subscribers?/i, '').trim(),
      niche:     (c.querySelector('#description-text')?.textContent || '').trim().slice(0, 80),
    })).filter(r => r.handle)
  , maxResults);
}

async function scrapeInstagram(page, keyword, maxResults, hadCookies) {
  // If we already injected a saved cookie, just verify the session by hitting the home page.
  // If the saved cookie is expired/invalid we get redirected to /accounts/login — fall back to credential login.
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (page.url().includes('/accounts/login')) {
    if (hadCookies) throw Object.assign(new Error('Saved Instagram cookie expired — re-paste a fresh sessionid'), { code: 'cookie_expired' });
    await loginInstagram(page);
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  }
  await page.waitForTimeout(2000);

  const q = encodeURIComponent(keyword.replace(/^#/, ''));

  // Try the internal topsearch API first — it returns JSON if Instagram trusts the session
  const apiData = await page.evaluate(async (query) => {
    try {
      const r = await fetch(`/api/v1/web/search/topsearch/?query=${query}&context=blended`, {
        headers: { 'X-IG-App-ID': '936619743392459', 'Accept': 'application/json' }
      });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('application/json')) return null;
      return r.json();
    } catch { return null; }
  }, q);

  if (apiData && apiData.users && apiData.users.length) {
    return apiData.users.slice(0, maxResults).map(u => {
      const user = u.user || u;
      return { handle: '@' + user.username, name: user.full_name || user.username, followers: String(user.follower_count || ''), niche: (user.biography || '').slice(0, 80) || 'Food' };
    });
  }

  // Fallback: scrape the search UI directly
  await page.goto(`https://www.instagram.com/explore/search/keyword/?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  const uiResults = await page.evaluate((max) => {
    // Account result rows on the search page have a profile-pic <img> next to a username link
    const links = Array.from(document.querySelectorAll('a[href^="/"][role="link"]'));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
      if (!m) continue;
      const username = m[1];
      if (seen.has(username) || ['p','reels','explore','accounts','direct','stories'].includes(username)) continue;
      seen.add(username);
      // Look for a sibling/nearby span that holds the display name
      const card = a.closest('div[role="none"], div');
      const nameEl = card ? card.querySelector('span:not(:has(*))') : null;
      out.push({
        username,
        full_name: (nameEl?.textContent || '').trim(),
      });
      if (out.length >= max) break;
    }
    return out;
  }, maxResults);

  if (!uiResults.length) {
    throw new Error('Instagram returned no results — search may be rate-limited or blocked');
  }

  return uiResults.map(u => ({
    handle: '@' + u.username,
    name: u.full_name || u.username,
    followers: '',  // not available on search UI — enrich step will fill in
    niche: 'Food',
  }));
}

async function scrapeTikTok(page, keyword, maxResults, hadCookies) {
  if (!hadCookies) await loginTikTok(page);
  const q = encodeURIComponent(keyword.replace(/^#/, ''));
  await page.goto(`https://www.tiktok.com/search/user?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(1500);
  await page.waitForSelector('[data-e2e="search-user-card"]', { timeout: 10000 }).catch(() => {});
  return page.evaluate((max) =>
    Array.from(document.querySelectorAll('[data-e2e="search-user-card"]')).slice(0, max).map(c => ({
      handle:    (c.querySelector('[data-e2e="search-user-unique-id"]')?.textContent || '').trim(),
      name:      (c.querySelector('[data-e2e="search-user-title"]')?.textContent || '').trim(),
      followers: (c.querySelector('[data-e2e="search-user-fans-count"]')?.textContent || '').trim(),
      niche:     (c.querySelector('[data-e2e="search-user-desc"]')?.textContent || '').trim().slice(0, 80),
    })).filter(r => r.handle)
  , maxResults);
}

async function scrapeX(page, keyword, maxResults, hadCookies) {
  if (!hadCookies) await loginX(page);
  const q = encodeURIComponent(keyword + ' food');
  await page.goto(`https://x.com/search?q=${q}&f=user`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 }).catch(() => {});
  return page.evaluate((max) =>
    Array.from(document.querySelectorAll('[data-testid="UserCell"]')).slice(0, max).map(c => {
      const profileLink = Array.from(c.querySelectorAll('a[href^="/"]')).find(a => a.href.split('/').length === 4 && !a.href.includes('status'));
      const handle = profileLink ? '@' + profileLink.href.split('/').pop() : '';
      return { handle, name: c.querySelector('[data-testid="UserName"] span')?.textContent?.trim() || '', niche: c.querySelector('[data-testid="UserDescription"]')?.textContent?.trim().slice(0, 80) || '' };
    }).filter(r => r.handle && !r.handle.includes('undefined'))
  , maxResults);
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;
  if (!TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });

  const { platform, keyword, maxResults = 20 } = req.body || {};
  if (!platform || !keyword) return res.status(400).json({ error: 'platform and keyword are required' });

  const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X / Twitter' };
  if (!PLATFORM_LABELS[platform]) return res.status(400).json({ error: 'Unknown platform' });

  let browser;
  try {
    browser = await chromium.connect({ wsEndpoint: WS_ENDPOINT });
    const context = browser.contexts()[0] || await browser.newContext();

    // Inject saved cookies before opening any page so the session is recognised on first request
    const savedCookies = await loadSavedCookies(platform);
    if (savedCookies && savedCookies.length) {
      await applyCookies(context, savedCookies);
    }

    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const hadCookies = !!(savedCookies && savedCookies.length);
    let raw = [];
    if (platform === 'youtube')   raw = await scrapeYouTube(page, keyword, maxResults);
    if (platform === 'instagram') raw = await scrapeInstagram(page, keyword, maxResults, hadCookies);
    if (platform === 'tiktok')    raw = await scrapeTikTok(page, keyword, maxResults, hadCookies);
    if (platform === 'x')         raw = await scrapeX(page, keyword, maxResults, hadCookies);

    const influencers = raw.map(r => ({
      handle:   r.handle.startsWith('@') ? r.handle : '@' + r.handle,
      name:     r.name || '',
      platform: PLATFORM_LABELS[platform],
      followers: normaliseFollowers(r.followers || ''),
      niche:    r.niche || 'Food',
      location: '',
      source:   `${PLATFORM_LABELS[platform]} native search`,
      foundVia: keyword,
    }));

    await browser.close();
    return res.status(200).json({ influencers, platform, keyword });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    const code = err.code || 'error';
    console.error(`[browser-scrape] ${platform}/${keyword} failed:`, err.message);
    return res.status(200).json({ error: code, message: err.message, influencers: [] });
  }
}
