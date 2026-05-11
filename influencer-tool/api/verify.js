// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Returns live follower count, bio, verified status for each handle.
//
// Instagram, TikTok, X: called directly from Node using the saved session cookie
// as a request header — no browser needed, fast and reliable.
// YouTube: public, no session needed, called directly from Node.

import { checkAuth } from './_auth.js';
import { createClient } from '@supabase/supabase-js';

async function loadSavedCookies(platform) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data } = await supabase.from('platform_sessions').select('cookies').eq('platform', platform).maybeSingle();
  return data?.cookies || null;
}

function stripAt(h) {
  return String(h || '').replace(/^@/, '').trim();
}

// Build a Cookie header string from saved cookies array
function cookieHeader(cookies) {
  return (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
}

// Fetch with a hard timeout
async function fetchWithTimeout(url, options, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────
async function verifyInstagram(username, cookieStr) {
  try {
    const resp = await fetchWithTimeout(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        headers: {
          'x-ig-app-id': '936619743392459',
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'cookie': cookieStr,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'referer': 'https://www.instagram.com/',
        },
      }
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
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ── TikTok ─────────────────────────────────────────────────────────────────
async function verifyTikTok(username, cookieStr) {
  try {
    const resp = await fetchWithTimeout(
      `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(username)}&aid=1988&app_language=en&app_name=tiktok_web`,
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'referer': 'https://www.tiktok.com/',
          'cookie': cookieStr,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      }
    );
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'cookie_expired' };
    if (resp.status === 404) return { ok: false, reason: 'not_found' };
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const json = await resp.json();
    const user  = json?.userInfo?.user;
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
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ── YouTube ────────────────────────────────────────────────────────────────
// Public — scrape subscriber count from the channel page HTML
async function verifyYouTube(username) {
  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/@${encodeURIComponent(username)}`,
      {
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
      12000
    );
    if (resp.status === 404) return { ok: false, reason: 'not_found' };
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const html = await resp.text();

    // Extract ytInitialData JSON from the page source
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (!m) return { ok: false, reason: 'no_page_data' };
    const data = JSON.parse(m[1]);

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
      country:    meta?.country || '',
    };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ── X / Twitter ────────────────────────────────────────────────────────────
async function verifyX(username, cookieStr) {
  try {
    const variables = encodeURIComponent(JSON.stringify({ screen_name: username, withSafetyModeUserFields: true }));
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
    const resp = await fetchWithTimeout(
      `https://x.com/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName?variables=${variables}&features=${features}`,
      {
        headers: {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          'content-type': 'application/json',
          'cookie': cookieStr,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      }
    );
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
      location:   user.location || '',
    };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  // Route to BrightData handler when action='brightdata'
  if ((req.body || {}).action === 'brightdata') {
    return handleBrightData(req, res);
  }

  const { platform, handles } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }
  if (!Array.isArray(handles) || !handles.length) {
    return res.status(400).json({ error: 'handles[] is required' });
  }

  // Load session cookie for platforms that need it
  const needsSession = platform !== 'youtube';
  let cookieStr = '';
  if (needsSession) {
    const cookies = await loadSavedCookies(platform);
    if (!cookies || !cookies.length) {
      const names = { instagram: 'sessionid', tiktok: 'sessionid', x: 'auth_token' };
      return res.status(400).json({
        error: 'cookie_missing',
        message: `No saved ${platform} session — paste your ${names[platform] || 'session'} cookie via the 🔑 button first`,
      });
    }
    cookieStr = cookieHeader(cookies);
  }

  const results = {};

  for (const rawHandle of handles) {
    const username = stripAt(rawHandle);
    if (!username) continue;

    let result;
    try {
      if (platform === 'instagram') result = await verifyInstagram(username, cookieStr);
      else if (platform === 'tiktok') result = await verifyTikTok(username, cookieStr);
      else if (platform === 'youtube') result = await verifyYouTube(username);
      else if (platform === 'x') result = await verifyX(username, cookieStr);
    } catch (e) {
      result = { ok: false, reason: e.message.slice(0, 120) };
    }

    results[rawHandle] = result;
    console.log(`[verify:${platform}] ${username}: ok=${result.ok} followers=${result.followers || '—'} reason=${result.reason || ''}`);

    if (result.reason === 'cookie_expired') {
      console.log(`[verify:${platform}] cookie expired, stopping batch`);
      break;
    }

    // Small delay between handles to stay under rate limits
    if (handles.indexOf(rawHandle) < handles.length - 1) {
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }
  }

  return res.status(200).json({ results });
}

// ── BrightData Web Scraper API ─────────────────────────────────────────────
// Called when body contains { action: 'brightdata', platform, profiles: [...] }

const BD_API = 'https://api.brightdata.com/datasets/v3';

const BD_DATASET_ENV = {
  instagram: 'BRIGHTDATA_IG_DATASET_ID',
  tiktok:    'BRIGHTDATA_TT_DATASET_ID',
  youtube:   'BRIGHTDATA_YT_DATASET_ID',
  x:         'BRIGHTDATA_X_DATASET_ID',
};

function bdProfileUrl(platform, handle) {
  const h = handle.replace(/^@/, '');
  if (platform === 'instagram') return `https://www.instagram.com/${h}/`;
  if (platform === 'tiktok')    return `https://www.tiktok.com/@${h}`;
  if (platform === 'youtube')   return `https://www.youtube.com/@${h}`;
  if (platform === 'x')         return `https://x.com/${h}`;
  return null;
}

function bdNormalise(platform, row) {
  if (!row) return null;
  if (platform === 'instagram') return {
    handle:     row.username   || '',
    fullName:   row.name       || row.full_name || '',
    followers:  String(row.followers   ?? row.follower_count  ?? ''),
    bio:        row.biography  || row.description || '',
    postCount:  String(row.posts ?? row.post_count ?? row.media_count ?? ''),
    isPrivate:  !!row.is_private,
    isVerified: !!(row.verified || row.is_verified),
  };
  if (platform === 'tiktok') return {
    handle:     row.unique_id  || row.username || '',
    fullName:   row.nickname   || row.name || '',
    followers:  String(row.fans ?? row.follower_count ?? row.followers ?? ''),
    bio:        row.signature  || row.bio || '',
    postCount:  String(row.video_count ?? row.post_count ?? ''),
    isPrivate:  !!row.is_private_account,
    isVerified: !!row.verified,
  };
  if (platform === 'youtube') return {
    handle:     row.channel_name || row.username || '',
    fullName:   row.channel_name || row.name || '',
    followers:  String(row.subscribers ?? row.subscriber_count ?? row.followers ?? ''),
    bio:        row.description || '',
    postCount:  String(row.video_count ?? ''),
    isPrivate:  false,
    isVerified: !!row.verified,
    country:    row.country || '',
  };
  if (platform === 'x') return {
    handle:     row.username    || row.screen_name || '',
    fullName:   row.name        || '',
    followers:  String(row.followers ?? row.followers_count ?? ''),
    bio:        row.description || row.bio || '',
    postCount:  String(row.posts ?? row.statuses_count ?? ''),
    isPrivate:  !!row.protected,
    isVerified: !!(row.verified || row.is_blue_verified),
    location:   row.location || '',
  };
  return null;
}

async function bdPollSnapshot(snapshotId, token, maxWaitMs = 120000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const resp = await fetch(`${BD_API}/snapshot/${snapshotId}?format=json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 202) continue;
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Snapshot poll failed: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
    }
    return resp;
  }
  throw new Error('BrightData snapshot timed out after 2 minutes');
}

async function handleBrightData(req, res) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });

  const { platform, profiles } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  if (!Array.isArray(profiles) || !profiles.length) return res.status(400).json({ error: 'profiles[] is required' });

  const datasetId = process.env[BD_DATASET_ENV[platform]];
  if (!datasetId) return res.status(500).json({ error: `${BD_DATASET_ENV[platform]} env var not set` });

  const inputs = profiles.map(p => ({ url: bdProfileUrl(platform, p) })).filter(r => r.url);

  // Trigger snapshot
  let snapshotId;
  try {
    const triggerResp = await fetch(
      `${BD_API}/trigger?dataset_id=${datasetId}&include_errors=true&format=json&uncompressed_webhook=true`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      }
    );
    const triggerData = await triggerResp.json();
    if (!triggerResp.ok) return res.status(502).json({ error: triggerData.message || triggerData.error || `BD trigger failed: HTTP ${triggerResp.status}` });
    snapshotId = triggerData.snapshot_id;
    if (!snapshotId) return res.status(502).json({ error: 'BrightData did not return a snapshot_id', raw: triggerData });
  } catch (e) {
    return res.status(502).json({ error: `BrightData trigger error: ${e.message}` });
  }

  console.log(`[brightdata:${platform}] snapshot triggered: ${snapshotId}`);

  // Poll until ready
  let rawRows;
  try {
    const snapResp = await bdPollSnapshot(snapshotId, token);
    const text = await snapResp.text();
    try {
      rawRows = JSON.parse(text);
    } catch {
      rawRows = text.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch (e) {
    return res.status(502).json({ error: e.message, snapshot_id: snapshotId });
  }

  if (!Array.isArray(rawRows)) rawRows = [rawRows].filter(Boolean);
  console.log(`[brightdata:${platform}] snapshot ${snapshotId} ready — ${rawRows.length} rows`);

  // Normalise and key by original handle
  const results = {};
  for (let i = 0; i < profiles.length; i++) {
    const handle = profiles[i].replace(/^@/, '');
    const row = rawRows[i] || rawRows.find(r =>
      (r.username || r.unique_id || r.screen_name || r.channel_name || '').toLowerCase() === handle.toLowerCase()
    );
    if (!row) { results[profiles[i]] = { error: 'not_found' }; continue; }
    if (row.error || row.status === 'failed') { results[profiles[i]] = { error: row.error || row.message || 'scrape_failed' }; continue; }
    results[profiles[i]] = bdNormalise(platform, row) || { error: 'normalise_failed' };
  }

  return res.status(200).json({ results, snapshot_id: snapshotId });
}
