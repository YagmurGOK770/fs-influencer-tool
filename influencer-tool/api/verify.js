// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Fetches each profile via the platform's internal API using the saved session cookie.
// YouTube is public — no session needed.
// Returns live follower count, bio, verified status, and post count for each handle.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.BROWSERLESS_TOKEN;
const WS_ENDPOINT = `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

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

// ── Instagram ──────────────────────────────────────────────────────────────
async function verifyInstagram(page, username) {
  return page.evaluate(async (u) => {
    try {
      const resp = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: { 'x-ig-app-id': '936619743392459', 'accept': '*/*' }, credentials: 'include' }
      );
      if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'cookie_expired' };
      if (resp.status === 404) return { ok: false, reason: 'not_found' };
      if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
      const json = await resp.json();
      const user = json?.data?.user;
      if (!user) return { ok: false, reason: 'no_user_data' };
      return {
        ok: true,
        followers:  String(user.edge_followed_by?.count ?? user.follower_count ?? ''),
        bio:        user.biography || '',
        fullName:   user.full_name || '',
        isPrivate:  !!user.is_private,
        isVerified: !!user.is_verified,
        postCount:  String(user.edge_owner_to_timeline_media?.count ?? user.media_count ?? ''),
      };
    } catch (e) { return { ok: false, reason: e.message }; }
  }, username);
}

// ── TikTok ─────────────────────────────────────────────────────────────────
async function verifyTikTok(page, username) {
  return page.evaluate(async (u) => {
    try {
      // TikTok's web API — requires session cookie for follower counts
      const resp = await fetch(
        `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(u)}&aid=1988&app_language=en&app_name=tiktok_web`,
        { headers: { 'accept': 'application/json, text/plain, */*', 'referer': 'https://www.tiktok.com/' }, credentials: 'include' }
      );
      if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'cookie_expired' };
      if (resp.status === 404) return { ok: false, reason: 'not_found' };
      if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
      const json = await resp.json();
      const user = json?.userInfo?.user;
      const stats = json?.userInfo?.stats;
      if (!user) return { ok: false, reason: 'no_user_data' };
      return {
        ok: true,
        followers:  String(stats?.followerCount ?? ''),
        bio:        user.signature || '',
        fullName:   user.nickname || '',
        isPrivate:  !!user.privateAccount,
        isVerified: !!user.verified,
        postCount:  String(stats?.videoCount ?? ''),
      };
    } catch (e) { return { ok: false, reason: e.message }; }
  }, username);
}

// ── YouTube ────────────────────────────────────────────────────────────────
// Public — no session needed. Navigates to /@handle and reads the page JSON.
async function verifyYouTube(page, username) {
  try {
    const url = `https://www.youtube.com/@${username}`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!resp || resp.status() === 404) return { ok: false, reason: 'not_found' };

    // YouTube embeds channel data in a ytInitialData JSON blob in the page
    const data = await page.evaluate(() => {
      try {
        const scripts = [...document.querySelectorAll('script')];
        for (const s of scripts) {
          const m = s.textContent.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
          if (m) return JSON.parse(m[1]);
        }
      } catch (_) {}
      return null;
    });

    if (!data) return { ok: false, reason: 'no_page_data' };

    // Subscriber count lives in channelMetadataRenderer or c4TabbedHeaderRenderer
    const header = data?.header?.c4TabbedHeaderRenderer
      || data?.header?.pageHeaderRenderer
      || {};
    const meta = data?.metadata?.channelMetadataRenderer || {};

    const subText =
      header?.subscriberCountText?.simpleText ||
      header?.subscriberCountText?.runs?.[0]?.text ||
      '';
    const description = meta?.description || '';
    const channelName = meta?.title || header?.title || '';

    return {
      ok: true,
      followers:  subText.replace(/\s*subscribers?/i, '').trim(),
      bio:        description.slice(0, 200),
      fullName:   channelName,
      isPrivate:  false,
      isVerified: !!(header?.badges?.some?.(b => b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED')),
      postCount:  '',
    };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── X / Twitter ────────────────────────────────────────────────────────────
async function verifyX(page, username) {
  return page.evaluate(async (u) => {
    try {
      // Twitter's internal GraphQL endpoint for user by screen name
      const variables = encodeURIComponent(JSON.stringify({ screen_name: u, withSafetyModeUserFields: true }));
      const features = encodeURIComponent(JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      }));
      const resp = await fetch(
        `https://x.com/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName?variables=${variables}&features=${features}`,
        {
          headers: {
            'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': 'en',
            'content-type': 'application/json',
          },
          credentials: 'include',
        }
      );
      if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'cookie_expired' };
      if (resp.status === 404) return { ok: false, reason: 'not_found' };
      if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
      const json = await resp.json();
      const user = json?.data?.user?.result?.legacy;
      if (!user) return { ok: false, reason: 'no_user_data' };
      return {
        ok: true,
        followers:  String(user.followers_count ?? ''),
        bio:        user.description || '',
        fullName:   user.name || '',
        isPrivate:  !!user.protected,
        isVerified: !!(json?.data?.user?.result?.is_blue_verified || user.verified),
        postCount:  String(user.statuses_count ?? ''),
      };
    } catch (e) { return { ok: false, reason: e.message }; }
  }, username);
}

// ── Session check helpers ───────────────────────────────────────────────────
async function checkInstagramSession(page) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  return !page.url().includes('/accounts/login') && !page.url().includes('/challenge/');
}

async function checkTikTokSession(page) {
  await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  // TikTok keeps you on tiktok.com whether logged in or not; check for login redirect
  return !page.url().includes('/login');
}

async function checkXSession(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
  return !page.url().includes('/i/flow/login') && !page.url().includes('login');
}

const SESSION_CHECKERS = {
  instagram: checkInstagramSession,
  tiktok:    checkTikTokSession,
  x:         checkXSession,
};

const VERIFIERS = {
  instagram: verifyInstagram,
  tiktok:    verifyTikTok,
  youtube:   verifyYouTube,
  x:         verifyX,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;
  if (!TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });

  const { platform, handles } = req.body || {};
  if (!VERIFIERS[platform]) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}. Must be instagram, tiktok, youtube, or x.` });
  }
  if (!Array.isArray(handles) || !handles.length) {
    return res.status(400).json({ error: 'handles[] is required' });
  }

  // YouTube is public — no session cookie needed
  const needsSession = platform !== 'youtube';
  let cookies = null;
  if (needsSession) {
    cookies = await loadSavedCookies(platform);
    if (!cookies || !cookies.length) {
      const names = { instagram: 'sessionid', tiktok: 'sessionid', x: 'auth_token' };
      return res.status(400).json({
        error: 'cookie_missing',
        message: `No saved ${platform} session — paste your ${names[platform] || 'session'} cookie via the 🔑 button first`,
      });
    }
  }

  let browser, context;
  try {
    browser = await chromium.connectOverCDP(WS_ENDPOINT);
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    if (cookies) await applyCookies(context, cookies);
    const page = await context.newPage();

    // Session validity check (skipped for YouTube)
    if (needsSession) {
      const checker = SESSION_CHECKERS[platform];
      if (checker) {
        const valid = await checker(page);
        if (!valid) {
          return res.status(401).json({
            error: 'cookie_expired',
            message: `Saved ${platform} cookie expired — paste a fresh one via 🔑`,
          });
        }
        await randDelay(page, 1000, 2000);
      }
    }

    const verifier = VERIFIERS[platform];
    const results = {};

    for (let i = 0; i < handles.length; i++) {
      const username = stripAt(handles[i]);
      if (!username) continue;

      if (i > 0) await randDelay(page, 1200, 2500);
      if (page.isClosed()) {
        console.log(`[verify:${platform}] page closed mid-loop, returning partial results`);
        break;
      }

      try {
        const result = await verifier(page, username);
        results[handles[i]] = result;
        console.log(`[verify:${platform}] ${username}: followers=${result.followers || '—'} ok=${result.ok}`);

        if (!result.ok && result.reason === 'cookie_expired') {
          console.log(`[verify:${platform}] cookie expired mid-batch, stopping`);
          break;
        }
      } catch (e) {
        console.log(`[verify:${platform}] ${username} failed: ${e.message.slice(0, 100)}`);
        results[handles[i]] = { ok: false, reason: e.message.slice(0, 100) };
        if (e.message.includes('closed') || e.message.includes('Target')) break;
      }
    }

    return res.status(200).json({ results });

  } catch (err) {
    console.error(`[verify:${platform}] error:`, err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (context) try { await context.close(); } catch (_) {}
    if (browser) try { await browser.close(); } catch (_) {}
  }
}
