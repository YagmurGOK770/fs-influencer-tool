// POST /api/browser-scrape
// Body: { connectURL, platform, keyword, maxResults }
// Attaches Playwright to an existing Browserless session and scrapes the platform.
// Returns { influencers: [...] } in the same shape as /api/search.

import { checkAuth } from './_auth.js';

function normaliseFollowers(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).replace(/,/g, '').trim();
  // Already formatted (e.g. "45.2K subscribers") — strip non-numeric suffix
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

async function scrapeYouTube(page, keyword, maxResults) {
  const q = encodeURIComponent(keyword + ' food london');
  await page.goto(
    `https://www.youtube.com/results?search_query=${q}&sp=EgIQAg%3D%3D`,
    { waitUntil: 'domcontentloaded', timeout: 20000 }
  );
  await page.locator('button:has-text("Accept all")').click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.waitForSelector('ytd-channel-renderer', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => window.scrollBy(0, 1200));
  await page.waitForTimeout(2000);

  return page.evaluate((max) => {
    return Array.from(document.querySelectorAll('ytd-channel-renderer'))
      .slice(0, max)
      .map(c => ({
        handle:    (c.querySelector('#channel-handle, yt-formatted-string#channel-handle')?.textContent || '').trim(),
        name:      (c.querySelector('#channel-title')?.textContent || '').trim(),
        followers: (c.querySelector('#subscribers')?.textContent || '').replace(/subscribers?/i, '').trim(),
        niche:     (c.querySelector('#description-text')?.textContent || '').trim().slice(0, 80),
      }))
      .filter(r => r.handle);
  }, maxResults);
}

async function scrapeInstagram(page, keyword, maxResults) {
  // Ensure we're logged in
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const url = page.url();
  if (url.includes('/accounts/login') || url.includes('/challenge/')) {
    throw Object.assign(new Error('login_required'), { code: url.includes('/challenge/') ? 'checkpoint' : 'login_required' });
  }
  await page.waitForTimeout(1000);

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
    return {
      handle:    '@' + user.username,
      name:      user.full_name || user.username,
      followers: String(user.follower_count || ''),
      niche:     (user.biography || '').slice(0, 80) || 'Food',
    };
  });
}

async function scrapeTikTok(page, keyword, maxResults) {
  const q = encodeURIComponent(keyword.replace(/^#/, ''));
  await page.goto(`https://www.tiktok.com/search/user?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

  if (page.url().includes('verify')) throw Object.assign(new Error('captcha'), { code: 'captcha' });

  const loginVisible = await page.locator('[data-e2e="login-modal"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (loginVisible) throw Object.assign(new Error('login_required'), { code: 'login_required' });

  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(1500);
  await page.waitForSelector('[data-e2e="search-user-card"]', { timeout: 10000 }).catch(() => {});

  return page.evaluate((max) => {
    return Array.from(document.querySelectorAll('[data-e2e="search-user-card"]'))
      .slice(0, max)
      .map(c => ({
        handle:    (c.querySelector('[data-e2e="search-user-unique-id"]')?.textContent || '').trim(),
        name:      (c.querySelector('[data-e2e="search-user-title"]')?.textContent || '').trim(),
        followers: (c.querySelector('[data-e2e="search-user-fans-count"]')?.textContent || '').trim(),
        niche:     (c.querySelector('[data-e2e="search-user-desc"]')?.textContent || '').trim().slice(0, 80),
      }))
      .filter(r => r.handle);
  }, maxResults);
}

async function scrapeX(page, keyword, maxResults) {
  const q = encodeURIComponent(keyword + ' food');
  await page.goto(`https://x.com/search?q=${q}&f=user`, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const loginVisible = await page.locator('[data-testid="LoginForm_Login_Button"]').isVisible({ timeout: 4000 }).catch(() => false);
  if (loginVisible) throw Object.assign(new Error('login_required'), { code: 'login_required' });

  await page.waitForTimeout(2000);
  await page.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 }).catch(() => {});

  return page.evaluate((max) => {
    return Array.from(document.querySelectorAll('[data-testid="UserCell"]'))
      .slice(0, max)
      .map(c => {
        const links = Array.from(c.querySelectorAll('a[href^="/"]'));
        const profileLink = links.find(a => a.href.split('/').length === 4 && !a.href.includes('status'));
        const handle = profileLink ? '@' + profileLink.href.split('/').pop() : '';
        const nameEl = c.querySelector('[data-testid="UserName"] span');
        const bio    = c.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() || '';
        return { handle, name: nameEl?.textContent?.trim() || '', niche: bio.slice(0, 80) };
      })
      .filter(r => r.handle && !r.handle.includes('undefined'));
  }, maxResults);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  const { connectURL, platform, keyword, maxResults = 20 } = req.body || {};
  if (!connectURL || !platform || !keyword) {
    return res.status(400).json({ error: 'connectURL, platform and keyword are required' });
  }

  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.connect({ wsEndpoint: connectURL });
    const page = await browser.newPage();

    let raw = [];
    if (platform === 'youtube')   raw = await scrapeYouTube(page, keyword, maxResults);
    if (platform === 'instagram') raw = await scrapeInstagram(page, keyword, maxResults);
    if (platform === 'tiktok')    raw = await scrapeTikTok(page, keyword, maxResults);
    if (platform === 'x')         raw = await scrapeX(page, keyword, maxResults);

    const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X / Twitter' };
    const influencers = raw.map(r => ({
      handle:    r.handle.startsWith('@') ? r.handle : '@' + r.handle,
      name:      r.name || '',
      platform:  PLATFORM_LABELS[platform] || platform,
      followers: normaliseFollowers(r.followers || ''),
      niche:     r.niche || 'Food',
      location:  '',
      source:    `${PLATFORM_LABELS[platform]} native search`,
      foundVia:  keyword,
    }));

    // Don't close the browser — session stays alive for further searches
    return res.status(200).json({ influencers, platform, keyword });

  } catch (err) {
    const code = err.code || 'error';
    return res.status(200).json({ error: code, message: err.message, influencers: [] });
  }
}
