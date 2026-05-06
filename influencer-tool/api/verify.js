// POST /api/verify
// Body: { platform: 'instagram', handles: ['@user1', '@user2', ...] }
// Fetches each profile via the Instagram internal JSON API using the saved session cookie.
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

async function verifyInstagram(page, username) {
  // Use Instagram's internal profile JSON API — far more stable than DOM scraping.
  // The session cookie applied to the browser context authenticates this request.
  const result = await page.evaluate(async (u) => {
    try {
      const resp = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        {
          headers: {
            'x-ig-app-id': '936619743392459',
            'accept': '*/*',
          },
          credentials: 'include',
        }
      );

      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, reason: 'cookie_expired' };
      }
      if (resp.status === 404) {
        return { ok: false, reason: 'not_found' };
      }
      if (!resp.ok) {
        return { ok: false, reason: `http_${resp.status}` };
      }

      const json = await resp.json();
      const user = json?.data?.user;
      if (!user) {
        return { ok: false, reason: 'no_user_data' };
      }

      return {
        ok: true,
        followers:   String(user.edge_followed_by?.count ?? user.follower_count ?? ''),
        bio:         user.biography || '',
        fullName:    user.full_name || '',
        isPrivate:   !!user.is_private,
        isVerified:  !!user.is_verified,
        postCount:   String(user.edge_owner_to_timeline_media?.count ?? user.media_count ?? ''),
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }, username);

  return result;
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

    // Quick session check — visit IG home; if bounced to login the cookie is dead
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (page.url().includes('/accounts/login') || page.url().includes('/challenge/')) {
      return res.status(401).json({ error: 'cookie_expired', message: 'Saved Instagram cookie expired — paste a fresh one via 🔑' });
    }
    await randDelay(page, 1500, 3000);

    const results = {};
    for (let i = 0; i < handles.length; i++) {
      const username = stripAt(handles[i]);
      if (!username) continue;

      // Human-paced gap between API calls to avoid rate limiting
      if (i > 0) await randDelay(page, 1200, 2500);

      if (page.isClosed()) {
        console.log('[verify] page closed mid-loop, returning partial results');
        break;
      }

      try {
        const result = await verifyInstagram(page, username);
        results[handles[i]] = result;
        console.log(`[verify] ${username}: followers=${result.followers || '—'} verified=${result.isVerified} ok=${result.ok}`);

        // If session expired mid-batch, stop and surface the error
        if (!result.ok && result.reason === 'cookie_expired') {
          console.log('[verify] cookie expired mid-batch, stopping');
          break;
        }
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
