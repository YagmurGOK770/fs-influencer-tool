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
import { chromium } from 'playwright';

const TOKEN = process.env.BROWSERLESS_TOKEN;
// BaaS V2 endpoint — use the region closest to your Vercel deployment (fra1 = Frankfurt)
const WS_ENDPOINT = `wss://production-lon.browserless.io?token=${TOKEN}`;

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

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[name="username"]', { timeout: 10000 });
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', pass);
  await page.click('button[type="submit"]');
  // Wait for redirect away from login page
  await page.waitForURL(url => !url.includes('/accounts/login'), { timeout: 15000 });
  // Dismiss "Save login info" / notifications prompts if present
  await page.locator('button:has-text("Not Now"), button:has-text("Not now")').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
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

async function scrapeInstagram(page, keyword, maxResults) {
  await loginInstagram(page);
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const q = encodeURIComponent(keyword.replace(/^#/, ''));
  const data = await page.evaluate(async (query) => {
    const r = await fetch(`/api/v1/web/search/topsearch/?query=${query}&context=blended`, {
      headers: { 'X-IG-App-ID': '936619743392459' }
    });
    if (!r.ok) return null;
    return r.json();
  }, q);
  if (!data || !data.users) return [];
  return data.users.slice(0, maxResults).map(u => {
    const user = u.user || u;
    return { handle: '@' + user.username, name: user.full_name || user.username, followers: String(user.follower_count || ''), niche: (user.biography || '').slice(0, 80) || 'Food' };
  });
}

async function scrapeTikTok(page, keyword, maxResults) {
  await loginTikTok(page);
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

async function scrapeX(page, keyword, maxResults) {
  await loginX(page);
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
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    let raw = [];
    if (platform === 'youtube')   raw = await scrapeYouTube(page, keyword, maxResults);
    if (platform === 'instagram') raw = await scrapeInstagram(page, keyword, maxResults);
    if (platform === 'tiktok')    raw = await scrapeTikTok(page, keyword, maxResults);
    if (platform === 'x')         raw = await scrapeX(page, keyword, maxResults);

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
    return res.status(200).json({ error: code, message: err.message, influencers: [] });
  }
}
