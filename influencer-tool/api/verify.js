// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Returns live follower count, bio, verified status for each handle.
// YouTube is public — no session needed. Others require a saved session cookie.

import { checkAuth } from './_auth.js';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.BROWSERLESS_TOKEN;
const WS_ENDPOINT = `wss://production-lon.browserless.io/playwright/chromium?token=${TOKEN}`;

// Short random delay between handles to avoid rate-limiting
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

function stripAt(h) {
  return String(h || '').replace(/^@/, '').trim();
}

// ── Instagram ──────────────────────────────────────────────────────────────
async function verifyInstagram(page, username) {
  return page.evaluate(async (u) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: { 'x-ig-app-id': '936619743392459', 'accept': '*/*' }, credentials: 'include', signal: ctrl.signal }
      );
      clearTimeout(t);
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
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }; }
  }, username);
}

// ── TikTok ─────────────────────────────────────────────────────────────────
async function verifyTikTok(page, username) {
  return page.evaluate(async (u) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(
        `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(u)}&aid=1988&app_language=en&app_name=tiktok_web`,
        { headers: { 'accept': 'application/json, text/plain, */*', 'referer': 'https://www.tiktok.com/' }, credentials: 'include', signal: ctrl.signal }
      );
      clearTimeout(t);
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
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }; }
  }, username);
}

// ── YouTube ────────────────────────────────────────────────────────────────
// Public — no session. Navigates to /@handle and reads embedded ytInitialData.
async function verifyYouTube(page, username) {
  try {
    const resp = await page.goto(`https://www.youtube.com/@${username}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!resp || resp.status() === 404) return { ok: false, reason: 'not_found' };

    const data = await page.evaluate(() => {
      try {
        for (const s of document.querySelectorAll('script')) {
          const m = s.textContent.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
          if (m) return JSON.parse(m[1]);
        }
      } catch (_) {}
      return null;
    });

    if (!data) return { ok: false, reason: 'no_page_data' };

    const header = data?.header?.c4TabbedHeaderRenderer || data?.header?.pageHeaderRenderer || {};
    const meta   = data?.metadata?.channelMetadataRenderer || {};
    const subText =
      header?.subscriberCountText?.simpleText ||
      header?.subscriberCountText?.runs?.[0]?.text || '';

    return {
      ok:         true,
      followers:  subText.replace(/\s*subscribers?/i, '').trim(),
      bio:        (meta?.description || '').slice(0, 200),
      fullName:   meta?.title || header?.title || '',
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
      const variables = encodeURIComponent(JSON.stringify({ screen_name: u, withSafetyModeUserFields: true }));
      const features  = encodeURIComponent(JSON.stringify({
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
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
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
          signal: ctrl.signal,
        }
      );
      clearTimeout(t);
      if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'cookie_expired' };
      if (resp.status === 404) return { ok: false, reason: 'not_found' };
      if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
      const json = await resp.json();
      const user = json?.data?.user?.result?.legacy;
      if (!user) return { ok: false, reason: 'no_user_data' };
      return {
        ok:         true,
        followers:  String(user.followers_count ?? ''),
        bio:        user.description || '',
        fullName:   user.name || '',
        isPrivate:  !!user.protected,
        isVerified: !!(json?.data?.user?.result?.is_blue_verified || user.verified),
        postCount:  String(user.statuses_count ?? ''),
      };
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }; }
  }, username);
}

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
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }
  if (!Array.isArray(handles) || !handles.length) {
    return res.status(400).json({ error: 'handles[] is required' });
  }

  // YouTube is public — no cookie needed
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
    // 15s timeout on all page.evaluate calls
    page.setDefaultTimeout(15000);

    // For YouTube we navigate per-handle (page.goto). For all others we use
    // fetch() inside page.evaluate() which picks up cookies from the context
    // automatically — no need to navigate to the platform home first.
    // Navigate to a neutral page so the browser has a real origin to fetch from.
    if (platform !== 'youtube') {
      const origin = { instagram: 'https://www.instagram.com', tiktok: 'https://www.tiktok.com', x: 'https://x.com' }[platform] || 'about:blank';
      await page.goto(origin + '/favicon.ico', { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
      // If we ended up on a login page the cookie is expired
      const url = page.url();
      if (url.includes('login') || url.includes('/challenge/')) {
        return res.status(401).json({ error: 'cookie_expired', message: `${platform} cookie expired — paste a fresh one via 🔑` });
      }
    }

    const verifier = VERIFIERS[platform];
    const results  = {};

    for (let i = 0; i < handles.length; i++) {
      const username = stripAt(handles[i]);
      if (!username) continue;

      // Small delay between handles to avoid rate-limiting (skip for YouTube which does page.goto)
      if (i > 0 && platform !== 'youtube') await randDelay(page, 600, 1200);

      if (page.isClosed()) {
        console.log(`[verify:${platform}] page closed mid-loop`);
        break;
      }

      try {
        const result = await verifier(page, username);
        results[handles[i]] = result;
        console.log(`[verify:${platform}] ${username}: followers=${result.followers || '—'} ok=${result.ok} reason=${result.reason || ''}`);

        if (!result.ok && result.reason === 'cookie_expired') {
          console.log(`[verify:${platform}] cookie expired mid-batch, stopping`);
          break;
        }
      } catch (e) {
        const msg = e.message.slice(0, 120);
        console.log(`[verify:${platform}] ${username} threw: ${msg}`);
        results[handles[i]] = { ok: false, reason: msg };
        // Stop if the browser context itself died
        if (msg.includes('closed') || msg.includes('Target') || msg.includes('disconnected')) break;
      }
    }

    return res.status(200).json({ results });

  } catch (err) {
    console.error(`[verify:${platform}] fatal:`, err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (context) try { await context.close(); } catch (_) {}
    if (browser)  try { await browser.close();  } catch (_) {}
  }
}
