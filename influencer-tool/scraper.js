/**
 * Influencer Tool — Local Playwright Scraper Companion
 *
 * Setup (run once):
 *   npm install playwright express
 *   npx playwright install chromium
 *
 * Start:
 *   node scraper.js
 *
 * The tool's UI will detect this server at http://localhost:3131
 * and offer "Native" search mode per platform.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const PORTS = [3131, 3132, 3133];
const PROFILE_DIR = path.join(__dirname, 'browser-profiles');
const RATE_LIMIT_MS = 30_000;

// Per-platform in-memory cache { platform: { ts, influencers } }
const cache = {};
// Per-platform browser contexts { platform: BrowserContext }
const contexts = {};
// Track last scrape time
const lastScrape = {};

let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('[scraper] playwright not installed — run: npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const PLATFORM_IDS = ['instagram', 'tiktok', 'youtube', 'x'];

const LOGIN_URLS = {
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok:    'https://www.tiktok.com/login',
  youtube:   'https://accounts.google.com/signin',
  x:         'https://x.com/i/flow/login',
};

const POST_LOGIN_PATTERNS = {
  instagram: u => u === 'https://www.instagram.com/' || (u.startsWith('https://www.instagram.com/') && !u.includes('login') && !u.includes('accounts')),
  tiktok:    u => u.includes('tiktok.com') && !u.includes('login'),
  youtube:   u => u.startsWith('https://www.youtube.com/') || u.startsWith('https://myaccount.google.com'),
  x:         u => u === 'https://x.com/home' || u === 'https://x.com/' || (u.startsWith('https://x.com/') && !u.includes('login') && !u.includes('flow')),
};

// ── Follower normalisation ──────────────────────────────────────────────────

function normaliseFollowers(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).replace(/,/g, '').trim();
  const num = parseFloat(s);
  if (isNaN(num)) return s;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(num));
}

// ── Browser context management ──────────────────────────────────────────────

async function getContext(platform, headless = true) {
  if (contexts[platform]) {
    try { await contexts[platform].pages(); return contexts[platform]; } catch { /* stale */ }
  }
  const profileDir = path.join(PROFILE_DIR, platform);
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await playwright.chromium.launchPersistentContext(profileDir, {
    headless,
    slowMo: 120,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  contexts[platform] = ctx;
  return ctx;
}

function hasSession(platform) {
  const profileDir = path.join(PROFILE_DIR, platform);
  // YouTube never needs a session
  if (platform === 'youtube') return true;
  // Presence of a non-empty profile directory = likely has session
  if (!fs.existsSync(profileDir)) return false;
  try {
    const files = fs.readdirSync(profileDir);
    return files.length > 2; // Chromium creates several files on first launch
  } catch { return false; }
}

// ── Per-platform scrapers ───────────────────────────────────────────────────

async function scrapeYouTube(keyword, maxResults) {
  const ctx = await getContext('youtube');
  const page = await ctx.newPage();
  try {
    const q = encodeURIComponent(keyword + ' food influencer london');
    await page.goto(`https://www.youtube.com/results?search_query=${q}&sp=EgIQAg%3D%3D`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Dismiss cookie consent if present
    await page.locator('button:has-text("Accept all")').click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(2000);

    await page.waitForSelector('ytd-channel-renderer', { timeout: 12000 }).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(2000);

    const results = await page.evaluate((max) => {
      const cards = Array.from(document.querySelectorAll('ytd-channel-renderer')).slice(0, max);
      return cards.map(c => {
        const handleEl = c.querySelector('yt-formatted-string#channel-handle, #channel-handle');
        const nameEl   = c.querySelector('#channel-title, yt-formatted-string.ytd-channel-renderer');
        const subsEl   = c.querySelector('#subscribers, [id="subscribers"]');
        const descEl   = c.querySelector('#description-text, [id="description-text"]');
        return {
          handle: (handleEl?.textContent || '').trim(),
          name:   (nameEl?.textContent   || '').trim(),
          followers: (subsEl?.textContent || '').replace(/subscribers?/i,'').trim(),
          niche: (descEl?.textContent || '').trim().slice(0, 80),
        };
      }).filter(r => r.handle);
    }, maxResults);

    return results.map(r => ({
      handle:   r.handle.startsWith('@') ? r.handle : '@' + r.handle,
      name:     r.name,
      platform: 'YouTube',
      followers: normaliseFollowers(r.followers.replace(/[^0-9.KkMm]/g, '') || r.followers),
      niche:    r.niche || 'Food',
      location: '',
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeInstagram(keyword, maxResults) {
  const ctx = await getContext('instagram');
  const page = await ctx.newPage();
  try {
    // Load Instagram first to establish session
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Check login wall
    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('/challenge/')) {
      return { error: url.includes('/challenge/') ? 'checkpoint' : 'login_required' };
    }
    await page.waitForTimeout(1500);

    // Use Instagram's internal topsearch endpoint via page context (carries session cookies)
    const q = encodeURIComponent(keyword.replace(/^#/, ''));
    const data = await page.evaluate(async (query) => {
      const resp = await fetch(`/api/v1/web/search/topsearch/?query=${query}&context=blended`, {
        headers: { 'X-IG-App-ID': '936619743392459' }
      });
      if (!resp.ok) return null;
      return resp.json();
    }, q);

    if (!data || !data.users) return [];

    return data.users.slice(0, maxResults).map(u => {
      const user = u.user || u;
      const fc = user.follower_count || 0;
      return {
        handle:   '@' + user.username,
        name:     user.full_name || user.username,
        platform: 'Instagram',
        followers: normaliseFollowers(fc),
        niche:    (user.biography || '').slice(0, 80) || 'Food',
        location: '',
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeTikTok(keyword, maxResults) {
  const ctx = await getContext('tiktok');
  const page = await ctx.newPage();
  try {
    const q = encodeURIComponent(keyword.replace(/^#/, ''));
    await page.goto(`https://www.tiktok.com/search/user?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    if (page.url().includes('verify')) return { error: 'captcha' };

    // Check login modal
    const loginModal = await page.locator('[data-e2e="login-modal"]').isVisible({ timeout: 3000 }).catch(() => false);
    if (loginModal) return { error: 'login_required' };

    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);

    await page.waitForSelector('[data-e2e="search-user-card"]', { timeout: 10000 }).catch(() => {});

    const results = await page.evaluate((max) => {
      const cards = Array.from(document.querySelectorAll('[data-e2e="search-user-card"]')).slice(0, max);
      return cards.map(c => ({
        handle:    (c.querySelector('[data-e2e="search-user-unique-id"]')?.textContent || '').trim(),
        name:      (c.querySelector('[data-e2e="search-user-title"]')?.textContent || '').trim(),
        followers: (c.querySelector('[data-e2e="search-user-fans-count"]')?.textContent || '').trim(),
        niche:     (c.querySelector('[data-e2e="search-user-desc"]')?.textContent || '').trim().slice(0, 80),
      })).filter(r => r.handle);
    }, maxResults);

    return results.map(r => ({
      handle:   r.handle.startsWith('@') ? r.handle : '@' + r.handle,
      name:     r.name,
      platform: 'TikTok',
      followers: normaliseFollowers(r.followers),
      niche:    r.niche || 'Food',
      location: '',
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeX(keyword, maxResults) {
  const ctx = await getContext('x');
  const page = await ctx.newPage();
  try {
    const q = encodeURIComponent(keyword + ' food');
    await page.goto(`https://x.com/search?q=${q}&f=user`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Check login wall
    const loginBtn = await page.locator('[data-testid="LoginForm_Login_Button"]').isVisible({ timeout: 4000 }).catch(() => false);
    if (loginBtn) return { error: 'login_required' };

    await page.waitForTimeout(2000);
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 }).catch(() => {});

    const results = await page.evaluate((max) => {
      const cells = Array.from(document.querySelectorAll('[data-testid="UserCell"]')).slice(0, max);
      return cells.map(c => {
        const links = Array.from(c.querySelectorAll('a[href^="/"]'));
        const handleLink = links.find(a => a.href.split('/').length === 4 && !a.href.includes('status'));
        const handle = handleLink ? '@' + handleLink.href.split('/').pop() : '';
        const nameSpans = c.querySelectorAll('[data-testid="UserName"] span');
        const name = nameSpans[0]?.textContent?.trim() || '';
        const bio  = c.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() || '';
        return { handle, name, bio };
      }).filter(r => r.handle && !r.handle.includes('undefined'));
    }, maxResults);

    // X doesn't show follower counts in search cards — return '?' and let enrich fill in
    return results.map(r => ({
      handle:   r.handle,
      name:     r.name,
      platform: 'X / Twitter',
      followers: '?',
      niche:    r.bio.slice(0, 80) || 'Food',
      location: '',
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Express server ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// GET /status
app.get('/status', (req, res) => {
  const sessions = {};
  for (const p of PLATFORM_IDS) {
    sessions[p] = {
      hasSession: hasSession(p),
      lastScrape: lastScrape[p] || null,
    };
  }
  res.json({ running: true, sessions });
});

// POST /scrape
app.post('/scrape', async (req, res) => {
  const { platform, keyword, maxResults = 20 } = req.body || {};
  if (!platform || !keyword) return res.status(400).json({ error: 'platform and keyword required' });
  if (!PLATFORM_IDS.includes(platform)) return res.status(400).json({ error: 'unknown platform' });

  // Rate limit
  const now = Date.now();
  if (cache[platform + keyword] && (now - cache[platform + keyword].ts) < RATE_LIMIT_MS) {
    console.log(`[scraper] cache hit for ${platform}/${keyword}`);
    return res.json({ influencers: cache[platform + keyword].influencers, cached: true, platform, keyword });
  }

  console.log(`[scraper] scraping ${platform} for "${keyword}"…`);
  try {
    let result;
    if (platform === 'youtube')   result = await scrapeYouTube(keyword, maxResults);
    if (platform === 'instagram') result = await scrapeInstagram(keyword, maxResults);
    if (platform === 'tiktok')    result = await scrapeTikTok(keyword, maxResults);
    if (platform === 'x')         result = await scrapeX(keyword, maxResults);

    if (result && result.error) {
      return res.json({ error: result.error, platform, keyword });
    }

    const influencers = (result || []).map(inf => ({
      ...inf,
      source: `${platform} native search`,
      foundVia: keyword,
    }));

    cache[platform + keyword] = { ts: now, influencers };
    lastScrape[platform] = new Date().toISOString();
    console.log(`[scraper] ${platform}/"${keyword}" → ${influencers.length} results`);
    res.json({ influencers, platform, keyword });
  } catch (err) {
    console.error(`[scraper] error on ${platform}:`, err.message);
    res.status(500).json({ error: err.message, platform, keyword });
  }
});

// GET /auth/:platform  — opens headed browser, long-polls until login detected (3 min timeout)
app.get('/auth/:platform', async (req, res) => {
  const { platform } = req.params;
  if (!PLATFORM_IDS.includes(platform)) return res.status(400).json({ error: 'unknown platform' });

  console.log(`[scraper] opening auth browser for ${platform}…`);

  // Close any existing context so we can reopen headed
  if (contexts[platform]) {
    try { await contexts[platform].close(); } catch {}
    delete contexts[platform];
  }

  let ctx;
  try {
    const profileDir = path.join(PROFILE_DIR, platform);
    fs.mkdirSync(profileDir, { recursive: true });
    ctx = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: false,
      slowMo: 80,
      args: ['--no-sandbox'],
      viewport: { width: 1280, height: 800 },
    });
    contexts[platform] = ctx;

    const page = await ctx.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Poll for post-login URL for up to 3 minutes
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      if (POST_LOGIN_PATTERNS[platform](url)) {
        console.log(`[scraper] ${platform} login detected at ${url}`);
        // Keep context open (headless=false session is now saved to profile dir)
        // Reopen as headless for future scraping
        try { await ctx.close(); } catch {}
        delete contexts[platform];
        return res.json({ ok: true, platform });
      }
    }

    try { await ctx.close(); } catch {}
    delete contexts[platform];
    return res.status(408).json({ error: 'Login timeout — please try again' });
  } catch (err) {
    if (ctx) { try { await ctx.close(); } catch {} delete contexts[platform]; }
    return res.status(500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let server;
  for (const port of PORTS) {
    try {
      server = await new Promise((resolve, reject) => {
        const s = app.listen(port, () => resolve(s));
        s.once('error', reject);
      });
      console.log(`[scraper] running on http://localhost:${port}`);
      console.log(`[scraper] sessions: ${PLATFORM_IDS.map(p => p + ':' + (hasSession(p) ? 'ok' : 'none')).join(', ')}`);
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') { console.warn(`[scraper] port ${port} in use, trying next…`); continue; }
      console.error('[scraper] fatal:', err.message); process.exit(1);
    }
  }
  if (!server) { console.error('[scraper] all ports in use'); process.exit(1); }
})();
