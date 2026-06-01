// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Returns live follower count, bio, verified status for each handle.
//
// Instagram, TikTok, X: routed through BrightData Web Unlocker to avoid 429s.
// YouTube: public, fetched directly (no blocking issues).

import { checkAuth } from './_auth.js';
import { createClient } from '@supabase/supabase-js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { fetchPostsForPlatform, postToRow, computeAggregates, runApifyActor } from './post-enrich.js';

// Lazy Supabase client (service key) for server-side persistence of scanned posts.
let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _sb = createClient(url, key);
  return _sb;
}
const avgOf = (posts, key) => {
  const v = posts.map(p => p[key]).filter(x => x != null && x >= 0);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

// ── BrightData Web Unlocker ────────────────────────────────────────────────
// Routes a request through BrightData Web Unlocker and returns the response text.
// Falls back to direct fetch if BRIGHTDATA_API_TOKEN / BRIGHTDATA_ZONE not set.
async function bdFetch(targetUrl, reqHeaders = {}, ms = 20000, method = 'GET', body = undefined) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone  = process.env.BRIGHTDATA_ZONE || 'influencer_proxy1';

  if (!token) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(targetUrl, { method, headers: reqHeaders, body, signal: ctrl.signal });
    } finally { clearTimeout(t); }
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        zone,
        url: targetUrl,
        method,
        format: 'raw',
        headers: reqHeaders,
        ...(body != null ? { body } : {}),
      }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

// ── Residential proxy fetch ────────────────────────────────────────────────
// Routes through BRIGHTDATA_PROXY_URL (raw TCP tunnel) without stripping headers.
// Used for TikTok profile pages — the Web Unlocker strips session management and
// returns empty bodies for TikTok, whereas the residential proxy passes through intact.
async function proxyFetch(url, reqHeaders = {}, ms = 30000) {
  const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const opts = {
      headers: reqHeaders,
      signal: ctrl.signal,
    };
    if (proxyUrl) {
      opts.dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: false },
        proxyTls:   { rejectUnauthorized: false },
      });
    }
    return await undiciFetch(url, opts);
  } finally { clearTimeout(t); }
}

function stripAt(h) {
  return String(h || '').replace(/^@/, '').trim();
}

// ── Instagram ──────────────────────────────────────────────────────────────
export async function verifyInstagram(username) {
  try {
    const resp = await bdFetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        'x-ig-app-id': '936619743392459',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://www.instagram.com/',
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
// TikTok's internal /api/user/detail/ requires signed requests BrightData can't
// produce (empty body returned). Scrape the profile page HTML instead — TikTok
// embeds full user data in __UNIVERSAL_DATA_FOR_REHYDRATION__ or __NEXT_DATA__.
// cookieRaw: optional TikTok session cookie string (sent via BrightData Web Unlocker
// with "Custom headers & cookies" enabled — allows TikTok to see a logged-in session
// instead of an anonymous bot request, which results in proper HTML being served).
// Batch TikTok verifier via Apify. One Apify run covers many usernames — much
// cheaper than per-call BrightData (which returns empty bodies for TT without
// a session cookie). Returns a Map keyed by lowercase handle.
//
// Requires APIFY_API_TOKEN in .env.local.
export async function verifyTikTokBatch(handles) {
  const token = process.env.APIFY_API_TOKEN;
  const result = new Map();
  const usernames = [...new Set(handles.map(h => String(h).toLowerCase().replace(/^@/, '').trim()).filter(Boolean))];
  if (!usernames.length) return result;
  if (!token) {
    console.warn('[tt-verify-batch] APIFY_API_TOKEN not set — marking all as no_apify_token');
    for (const h of usernames) result.set(h, { ok: false, reason: 'no_apify_token' });
    return result;
  }
  try {
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profiles: usernames,
          resultsPerPage: 1, // we only need to know the user exists + author metadata
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSubtitles: false,
          shouldDownloadSlideshowImages: false,
        }),
      }
    );
    const runData = await runResp.json();
    const runId = runData?.data?.id;
    const datasetId = runData?.data?.defaultDatasetId;
    if (!runId) throw new Error(`apify_start_failed: ${JSON.stringify(runData).slice(0, 200)}`);
    console.log(`[tt-verify-batch] Apify run ${runId} started for ${usernames.length} handles`);

    const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
    let finalStatus = 'UNKNOWN';
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      const sResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
      const sData = await sResp.json();
      finalStatus = sData?.data?.status;
      if (finalStatus === 'SUCCEEDED') break;
      if (TERMINAL.has(finalStatus)) throw new Error(`apify_${finalStatus.toLowerCase()}: ${sData?.data?.statusMessage || ''}`);
    }
    if (finalStatus !== 'SUCCEEDED') throw new Error('apify_timeout');

    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`);
    const items = await itemsResp.json();
    for (const item of items) {
      const meta = item.authorMeta || {};
      const handle = (meta.name || item.author?.uniqueId || '').toLowerCase();
      if (!handle || result.has(handle)) continue;
      result.set(handle, {
        ok: true,
        followers:  String(meta.fans ?? meta.followerCount ?? ''),
        bio:        meta.signature || '',
        fullName:   meta.nickName || meta.nickname || '',
        isPrivate:  !!meta.privateAccount,
        isVerified: !!meta.verified,
        postCount:  String(meta.video ?? meta.videoCount ?? ''),
      });
    }
    // Mark not-found handles
    for (const h of usernames) {
      if (!result.has(h)) result.set(h, { ok: false, reason: 'not_found' });
    }
    console.log(`[tt-verify-batch] ${usernames.length} → found ${[...result.values()].filter(v => v.ok).length}`);
  } catch (e) {
    console.warn('[tt-verify-batch] failed:', e.message);
    for (const h of usernames) if (!result.has(h)) result.set(h, { ok: false, reason: e.message });
  }
  return result;
}

export async function verifyTikTok(username, cookieRaw) {
  const ttHeaders = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
    ...(cookieRaw ? { 'cookie': cookieRaw } : {}),
  };

  // Use Web Unlocker (bdFetch) with cookie forwarded — requires "Custom headers & cookies"
  // to be enabled in the BrightData influencer_proxy1 zone Advanced settings.
  let resp = null;
  try {
    resp = await bdFetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, ttHeaders, 30000);
    const ct = resp.headers?.get?.('content-type') || 'none';
    console.log(`[tt-verify] @${username} status=${resp.status} ct=${ct} cookie=${cookieRaw ? 'yes' : 'no'}`);
  } catch (bdErr) {
    const cause = bdErr.cause?.message || bdErr.cause?.code || '';
    console.log(`[tt-verify] @${username} error: ${bdErr.message}${cause ? ' cause=' + cause : ''}`);
    return { ok: false, reason: bdErr.message };
  }

  try {
    if (resp.status === 404) return { ok: false, reason: 'not_found' };
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };

    const html = await resp.text();
    if (!html || html.length < 200) {
      console.log(`[tt-verify] @${username} empty body (${html?.length || 0}b)`);
      return { ok: false, reason: 'empty_response' };
    }
    console.log(`[tt-verify] @${username} body=${html.length}b starts=${html.slice(0, 120).replace(/\s+/g, ' ')}`);


    let user = null, stats = null;

    // Newer TikTok: __UNIVERSAL_DATA_FOR_REHYDRATION__
    const udrM = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (udrM) {
      try {
        const udr = JSON.parse(udrM[1]);
        const scope = udr?.['__DEFAULT_SCOPE__'] || {};
        const detail = scope['webapp.user-detail'] || scope['user-detail'] || {};
        const info = detail?.userInfo || detail;
        user  = info?.user  || null;
        stats = info?.stats || null;
      } catch {}
    }

    // Older TikTok: __NEXT_DATA__
    if (!user) {
      const nextM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextM) {
        try {
          const next = JSON.parse(nextM[1]);
          const info = next?.props?.pageProps?.userInfo;
          user  = info?.user  || null;
          stats = info?.stats || null;
        } catch {}
      }
    }

    if (!user) {
      // Log a snippet to aid future debugging without spamming
      const snippet = html.slice(0, 300).replace(/\s+/g, ' ');
      console.log(`[tt-verify] @${username} no user data (${html.length}b). snippet: ${snippet}`);
      return { ok: false, reason: 'no_user_data' };
    }

    return {
      ok:         true,
      followers:  String(stats?.followerCount ?? stats?.fans ?? ''),
      bio:        user.signature || '',
      fullName:   user.nickname  || '',
      isPrivate:  !!user.privateAccount,
      isVerified: !!user.verified,
      postCount:  String(stats?.videoCount ?? ''),
    };
  } catch (e) {
    const cause = e.cause?.message || e.cause?.code || e.cause?.toString() || '';
    console.log(`[tt-verify] @${username} error: ${e.message}${cause ? ' cause=' + cause : ''}`);
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ── YouTube ────────────────────────────────────────────────────────────────
// Public — fetched directly, no proxy needed
export async function verifyYouTube(username) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let resp;
    try {
      resp = await fetch(`https://www.youtube.com/@${encodeURIComponent(username)}`, {
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    if (resp.status === 404) return { ok: false, reason: 'not_found' };
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const html = await resp.text();
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (!m) return { ok: false, reason: 'no_page_data' };
    const data = JSON.parse(m[1]);
    const header = data?.header?.c4TabbedHeaderRenderer || data?.header?.pageHeaderRenderer || {};
    const meta   = data?.metadata?.channelMetadataRenderer || {};
    const subText = header?.subscriberCountText?.simpleText || header?.subscriberCountText?.runs?.[0]?.text || '';
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
export async function verifyX(username) {
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
    const resp = await bdFetch(
      `https://x.com/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName?variables=${variables}&features=${features}`,
      {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'content-type': 'application/json',
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

  // Route to BrightData handlers
  if ((req.body || {}).action === 'brightdata') {
    return handleBrightData(req, res);
  }
  if ((req.body || {}).action === 'bd-search') {
    return handleBdSearch(req, res);
  }
  if ((req.body || {}).action === 'bd-search-status') {
    return handleBdSearchStatus(req, res);
  }
  if ((req.body || {}).action === 'bd-scan-posts') {
    return handleBdScanPosts(req, res);
  }
  if ((req.body || {}).action === 'yt-enrich') {
    return handleYtEnrich(req, res);
  }

  const { platform, handles } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }
  if (!Array.isArray(handles) || !handles.length) {
    return res.status(400).json({ error: 'handles[] is required' });
  }

  const results = {};

  for (const rawHandle of handles) {
    const username = stripAt(rawHandle);
    if (!username) continue;

    let result;
    try {
      if (platform === 'instagram') result = await verifyInstagram(username);
      else if (platform === 'tiktok') result = await verifyTikTok(username);
      else if (platform === 'youtube') result = await verifyYouTube(username);
      else if (platform === 'x') result = await verifyX(username);
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

// ── BrightData Search: hashtag / keyword discovery ────────────────────────
// Called when body contains { action: 'bd-search', platform, keyword }
//
// Calls platform APIs directly through BrightData Web Unlocker.
// No timeout issues when running locally via `node devserver.mjs`.
// On Vercel (10s limit) this will timeout — use locally for discovery.

// In-flight search progress, keyed by searchId.
// Stored on globalThis so it survives devserver module re-imports.
const searchProgress = globalThis.__searchProgress ||= new Map();
if (!globalThis.__searchProgressCleanup) {
  globalThis.__searchProgressCleanup = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10-minute TTL
    for (const [id, p] of searchProgress) {
      if (p.lastUpdate < cutoff) searchProgress.delete(id);
    }
  }, 60_000).unref?.();
}

function updateProgress(searchId, patch) {
  const prev = searchProgress.get(searchId) || {};
  searchProgress.set(searchId, { ...prev, ...patch, lastUpdate: Date.now() });
}

async function igHashtagSearch(keyword, _sessionCookies, onProgress = () => {}) {
  // Migrated off the multi-account cookie pool: discovery now uses the Apify Instagram
  // scraper in hashtag mode. Follower counts are NOT fetched at discovery time (cheaper) —
  // they get filled later by the enrichment / verify steps. Returns the same profile shape
  // the BD Results UI already expects.
  const tag = keyword.replace(/^#/, '').toLowerCase().trim();
  const RESULTS_LIMIT = 200; // hashtag posts to pull per search

  onProgress({ phase: 'searching', current: 0, total: RESULTS_LIMIT });
  const items = await runApifyActor('apify/instagram-scraper', {
    directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`],
    resultsType: 'posts',
    resultsLimit: RESULTS_LIMIT,
    addParentData: false,
  }, { onProgress: ({ itemCount }) => onProgress({ phase: 'searching', current: Math.min(itemCount, RESULTS_LIMIT), total: RESULTS_LIMIT }) });

  // Group posts by owner → one candidate profile each, aggregating hashtag-post engagement.
  const byOwner = new Map();
  for (const it of items) {
    const username = (it.ownerUsername || '').toLowerCase();
    if (!username) continue;
    if (!byOwner.has(username)) byOwner.set(username, { stub: it, posts: [] });
    byOwner.get(username).posts.push({
      likes:    Number(it.likesCount)    >= 0 ? Number(it.likesCount)    : 0,
      comments: Number(it.commentsCount) >= 0 ? Number(it.commentsCount) : 0,
      caption:  (it.caption || '').slice(0, 800),
      location: it.locationName || '',
    });
  }

  const profiles = [];
  for (const [, { stub, posts }] of byOwner) {
    const pc = posts.length;
    const avgLikes    = pc ? Math.round(posts.reduce((s, p) => s + p.likes, 0)    / pc) : 0;
    const avgComments = pc ? Math.round(posts.reduce((s, p) => s + p.comments, 0) / pc) : 0;
    profiles.push({
      handle:        stub.ownerUsername,
      pk:            stub.ownerId ? String(stub.ownerId) : '',
      fullName:      stub.ownerFullName || '',
      followers:     '',          // not fetched at discovery (Apify hashtag-only)
      bio:           '',
      isVerified:    false,
      postCount:     '',
      profileUrl:    `https://www.instagram.com/${stub.ownerUsername}/`,
      rawPlatform:   'instagram',
      hashtagPosts:  pc,
      avgLikes,
      avgComments,
      engagementRate: 0,          // needs follower count
      postCaptions:  posts.map(p => p.caption).filter(Boolean),
      postLocations: [...new Set(posts.map(p => p.location).filter(Boolean))],
    });
  }

  console.log(`[ig-search] #${tag} → ${profiles.length} profiles via Apify (${items.length} posts)`);
  onProgress({ phase: 'enriching', current: profiles.length, total: profiles.length });
  return { profiles, callCount: 1 };
}

// ── TikTok Research API ────────────────────────────────────────────────────
// Requires TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET from developers.tiktok.com
// → My Apps → Add product → Research API
async function ttResearchHashtagSearch(keyword, onProgress) {
  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

  // 1. Client-credentials token
  const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error(`TikTok token error: ${JSON.stringify(tokenData)}`);
  const token = tokenData.access_token;

  // 2. Query videos by hashtag (last 90 days, up to 100 results)
  const tag = keyword.replace(/^#/, '').trim();
  const toDate   = new Date();
  const fromDate = new Date(toDate - 90 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

  onProgress({ phase: 'searching', current: 0, total: 100 });
  const fields = 'id,username,region_code,video_description,like_count,comment_count,share_count,view_count';
  const queryResp = await fetch(`https://open.tiktokapis.com/v2/research/video/query/?fields=${fields}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { and: [{ operation: 'IN', field_name: 'hashtag_name', field_values: [tag] }] },
      start_date: fmt(fromDate),
      end_date:   fmt(toDate),
      max_count:  100,
    }),
  });
  const queryData = await queryResp.json();
  const videos = queryData?.data?.videos || [];
  console.log(`[tt-research] hashtag="${tag}" → ${videos.length} videos`);

  // 3. Deduplicate authors then fetch each user's profile
  const handles = [...new Set(videos.map(v => v.username).filter(Boolean))];
  onProgress({ phase: 'enriching', current: 0, total: handles.length });

  const userFields = 'display_name,bio_description,is_verified,follower_count,following_count,likes_count,video_count';
  const profiles = [];
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    try {
      const uResp = await fetch(`https://open.tiktokapis.com/v2/research/user/info/?fields=${userFields}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: handle }),
      });
      const uData = await uResp.json();
      const u = uData?.data?.user_info || uData?.data;
      if (u) {
        profiles.push({
          handle,
          fullName:   u.display_name  || '',
          followers:  String(u.follower_count ?? ''),
          bio:        u.bio_description || '',
          isVerified: !!u.is_verified,
          postCount:  String(u.video_count ?? ''),
          profileUrl: `https://www.tiktok.com/@${handle}`,
          rawPlatform: 'tiktok',
        });
      }
    } catch (_) {}
    onProgress({ phase: 'enriching', current: i + 1, total: handles.length });
    if (i < handles.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[tt-research] "${tag}" → ${profiles.length} creator profiles`);
  return profiles;
}

// ── TikTok via Apify scraper ───────────────────────────────────────────────
// Requires APIFY_API_TOKEN from console.apify.com
// Uses the clockworks/tiktok-scraper actor — searches by hashtag and returns
// video list with full author metadata (follower count, bio, etc.)
async function ttApifyHashtagSearch(keyword, onProgress) {
  const token  = process.env.APIFY_API_TOKEN;
  const tag    = keyword.replace(/^#/, '').trim();

  // 1. Start actor run
  const runResp = await fetch(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hashtags:                [tag],
        resultsPerPage:          100,
        shouldDownloadVideos:    false,
        shouldDownloadCovers:    false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      }),
    }
  );
  const runData = await runResp.json();
  const runId   = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;
  if (!runId) throw new Error(`Apify run failed to start: ${JSON.stringify(runData)}`);
  console.log(`[tt-apify] run started runId=${runId} hashtag="${tag}"`);

  // 2. Poll until finished (SUCCEEDED / FAILED / ABORTED / TIMED-OUT)
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
  let attempts = 0;
  while (attempts++ < 60) {
    await new Promise(r => setTimeout(r, 5000));
    const sResp  = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const sData  = await sResp.json();
    const status = sData?.data?.status;
    const itemCount = sData?.data?.stats?.itemCount ?? 0;
    console.log(`[tt-apify] run=${runId} status=${status} items=${itemCount}`);
    onProgress({ phase: 'searching', current: Math.min(itemCount, 100), total: 100 });
    if (status === 'SUCCEEDED') break;
    if (TERMINAL.has(status)) throw new Error(`Apify run ${status}`);
  }

  // 3. Fetch dataset items
  const itemsResp = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`
  );
  const items = await itemsResp.json();
  console.log(`[tt-apify] dataset=${datasetId} → ${items.length} video items`);

  // 4. Group videos by author, aggregate engagement metrics in one pass
  // Each Apify item already has full author metadata + per-video stats — no
  // separate enrichment step needed (unlike Instagram which requires extra calls).
  const authorVideos = new Map(); // handle → { meta, videos[] }
  for (const item of items) {
    const handle = item.authorMeta?.name || item.author?.uniqueId;
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (!authorVideos.has(key)) authorVideos.set(key, { meta: item.authorMeta || {}, videos: [] });
    authorVideos.get(key).videos.push({
      caption:  item.text || item.desc || '',
      likes:    item.diggCount    ?? item.stats?.diggCount    ?? 0,
      comments: item.commentCount ?? item.stats?.commentCount ?? 0,
      shares:   item.shareCount   ?? item.stats?.shareCount   ?? 0,
      views:    item.playCount    ?? item.stats?.playCount    ?? 0,
      // Location tagging is rare on TikTok — capture when present
      location: item.locationCreated?.city || item.locationCreated?.country || '',
    });
  }

  const profiles = [];
  for (const [, { meta, videos }] of authorVideos) {
    const handle = meta.name || meta.uniqueId;
    if (!handle) continue;

    const totalLikes    = videos.reduce((s, v) => s + v.likes,    0);
    const totalComments = videos.reduce((s, v) => s + v.comments, 0);
    const totalViews    = videos.reduce((s, v) => s + v.views,    0);
    const avgLikes      = videos.length ? Math.round(totalLikes    / videos.length) : 0;
    const avgComments   = videos.length ? Math.round(totalComments / videos.length) : 0;
    const avgViews      = videos.length ? Math.round(totalViews    / videos.length) : 0;
    const followers     = Number(meta.fans ?? meta.followerCount ?? 0);
    const engagementRate = followers > 0
      ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100
      : 0;

    profiles.push({
      handle,
      fullName:      meta.nickName  || meta.nickname || '',
      followers:     String(followers || ''),
      bio:           meta.signature || '',
      isVerified:    !!(meta.verified),
      postCount:     String(meta.video ?? meta.videoCount ?? ''),
      profileUrl:    `https://www.tiktok.com/@${handle}`,
      rawPlatform:   'tiktok',
      hashtagPosts:  videos.length,
      avgLikes,
      avgComments,
      avgViews,
      engagementRate,
      postCaptions:  videos.map(v => v.caption).filter(Boolean),
      // postLocations: sparse on TikTok — video location tags are rarely set.
      // creatorRegion is the reliable alternative (author's registered country).
      postLocations:  [...new Set(videos.map(v => v.location).filter(Boolean))],
      creatorRegion:  meta.region || meta.country || '',
    });
  }
  console.log(`[tt-apify] "${tag}" → ${profiles.length} unique creators (with post data)`);
  return profiles;
}

// ── TikTok search router ───────────────────────────────────────────────────
// Priority: Research API → Apify → nothing (BrightData KYC not completed)
async function ttHashtagSearch(keyword, onProgress) {
  const hasResearch = process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET;
  const hasApify    = !!process.env.APIFY_API_TOKEN;

  if (hasResearch) {
    console.log(`[tt-search] routing via TikTok Research API`);
    return ttResearchHashtagSearch(keyword, onProgress);
  }
  if (hasApify) {
    console.log(`[tt-search] routing via Apify`);
    return ttApifyHashtagSearch(keyword, onProgress);
  }
  console.log(`[tt-search] no TikTok backend configured — set APIFY_API_TOKEN or TIKTOK_CLIENT_KEY+SECRET in .env.local`);
  return [];
}

// Robustly extract a balanced JSON object starting at `startPos` in `html`.
// Avoids regex which breaks when the JSON contains }; inside string values.
function extractBalancedJson(html, startPos) {
  let depth = 0, inString = false, escape = false;
  for (let i = startPos; i < html.length; i++) {
    const c = html[i];
    if (escape)           { escape = false; continue; }
    if (c === '\\' && inString) { escape = true;  continue; }
    if (c === '"')        { inString = !inString; continue; }
    if (inString)         continue;
    if (c === '{')        depth++;
    else if (c === '}') { if (--depth === 0) return html.slice(startPos, i + 1); }
  }
  throw new Error('Unterminated JSON object');
}

// Shared helper: fetch one YouTube channel page and return enrichment fields.
// Fetches the /about tab which includes totalViews, country, and subscriber count
// in the aboutChannelViewModel — not available on the main channel page.
async function ytEnrichOne(handle, profileUrl) {
  const base = (profileUrl || `https://www.youtube.com/@${handle}`).replace(/\/about\/?$/, '');
  const url = `${base}/about`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let html;
  try {
    const resp = await fetch(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }

  const MARKERS = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  let data = null;
  for (const marker of MARKERS) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    try { data = JSON.parse(extractBalancedJson(html, idx + marker.length)); break; } catch (_) {}
  }
  if (!data) throw new Error('no ytInitialData');

  function deepFind(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (key in node) return node[key];
    for (const v of Object.values(node)) {
      const r = Array.isArray(v)
        ? v.reduce((a, x) => a !== undefined ? a : deepFind(x, key), undefined)
        : deepFind(v, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // aboutChannelViewModel (on /about tab): has totalViews, country, subscriber count as plain strings
  const aboutVM = deepFind(data, 'aboutChannelViewModel');
  const totalViews = String(aboutVM?.viewCountText || '').replace(/\s*views?/i, '').replace(/,/g, '').trim();
  let country     = aboutVM?.country || deepFind(data, 'channelMetadataRenderer')?.country || '';
  let subscribers = String(aboutVM?.subscriberCountText || '').replace(/\s*subscribers?/i, '').trim();

  // Video count: header nodes (old format) or pageHeaderViewModel metadataRows (new format)
  const videoCountText = deepFind(data, 'videoCountText');
  let videoCount = (videoCountText?.runs?.map(r => r.text).join('') || videoCountText?.simpleText || '').replace(/\s*videos?/i, '').replace(/,/g, '').trim();

  if (!videoCount || !subscribers) {
    const rows = data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    for (const row of rows) {
      for (const part of (row.metadataParts || [])) {
        const txt = part.text?.content || '';
        if (!subscribers) {
          const m = txt.match(/([\d.,]+[KMB]?)\s+subscribers?/i);
          if (m) subscribers = m[1];
        }
        if (!videoCount) {
          const m = txt.match(/([\d,]+[KMBTkmbt]?)\s+videos?/i);
          if (m) videoCount = m[1].replace(/,/g, '');
        }
      }
    }
  }

  const channelMeta = deepFind(data, 'channelMetadataRenderer');
  const description = channelMeta?.description || deepFind(data, 'microformatDataRenderer')?.description?.simpleText || '';

  return { videoCount, totalViews, subscribers, country, description };
}

async function ytKeywordSearch(keyword) {
  // YouTube search page embeds ytInitialData server-side — parse it directly.
  // Use direct fetch (no BrightData proxy) — YouTube is public and proxy adds latency.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let resp;
  try {
    resp = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`,
      {
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: ctrl.signal,
      }
    );
  } finally { clearTimeout(t); }

  if (!resp.ok) throw new Error(`YouTube search HTTP ${resp.status}`);
  const html = await resp.text();
  console.log(`[yt-search] page fetched (${html.length}b)`);

  // Locate ytInitialData — try multiple markers YouTube has used over time
  const MARKERS = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  let data = null;
  for (const marker of MARKERS) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    try {
      const jsonStr = extractBalancedJson(html, idx + marker.length);
      data = JSON.parse(jsonStr);
      break;
    } catch (e) {
      console.log(`[yt-search] marker "${marker.trim()}" parse failed: ${e.message}`);
    }
  }
  if (!data) throw new Error('YouTube: could not find/parse ytInitialData in page');

  // Collect all channelRenderer objects anywhere in the page tree
  const channels = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.channelRenderer) channels.push(node.channelRenderer);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  }
  walk(data);

  const profiles = [];
  const seen = new Set();
  for (let i = 0; i < channels.length; i++) {
    const p = buildProfile(channels[i], i === 0);
    if (p) profiles.push(p);
  }
  // Paginate via YouTube InnerTube continuation API (up to 2 extra pages ≈ 60 total)
  function extractContinuation(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.continuationCommand?.token) return node.continuationCommand.token;
    if (node.token && typeof node.token === 'string' && node.token.length > 20) return node.token;
    for (const v of Object.values(node)) {
      const r = Array.isArray(v) ? v.reduce((a, x) => a || extractContinuation(x), null) : extractContinuation(v);
      if (r) return r;
    }
    return null;
  }

  function buildProfile(ch, logRaw) {
    const channelId   = ch.channelId || ch.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!channelId || seen.has(channelId)) return null;
    seen.add(channelId);
    // Log raw keys of the first channel so we can discover all available fields
    if (logRaw) console.log('[yt-channel-raw-keys]', JSON.stringify(Object.keys(ch)));
    if (logRaw) console.log('[yt-channel-raw]', JSON.stringify(ch).slice(0, 2000));
    const canonicalUrl = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    const atMatch      = canonicalUrl.match(/^\/@(.+)$/);
    const handle       = atMatch ? atMatch[1] : channelId;
    const subRaw       = ch.subscriberCountText?.simpleText || ch.subscriberCountText?.runs?.map(r => r.text).join('') || '';
    const videoRaw     = ch.videoCountText?.runs?.map(r => r.text).join('') || ch.videoCountText?.simpleText || '';
    const subCleaned   = subRaw.replace(/\s*subscribers?/i, '').trim();
    const videoCleaned = videoRaw.replace(/\s*subscribers?/i, '').trim();
    // viewCountText may appear for some channels (total channel views)
    // YouTube search results do NOT include video count, views, or engagement data.
    // videoCountText = subscribers (mislabelled), subscriberCountText = @handle (mislabelled).
    let followers;
    if (/^\d/.test(subCleaned))        followers = subCleaned;
    else if (/^\d/.test(videoCleaned)) followers = videoCleaned;
    else                               followers = '';
    const thumbs = ch.thumbnail?.thumbnails || [];
    const avatarUrl = thumbs.length ? ('https:' + (thumbs[thumbs.length - 1].url || thumbs[0].url)) : '';
    return {
      handle, followers, postCount: '',
      avatarUrl,
      fullName:   ch.title?.simpleText || ch.title?.runs?.map(r => r.text).join('') || '',
      bio:        ch.descriptionSnippet?.runs?.map(r => r.text).join('') || '',
      isVerified: !!(ch.ownerBadges?.some(b => b?.metadataBadgeRenderer?.style?.includes('VERIFIED') || b?.metadataBadgeRenderer?.icon?.iconType === 'CHECK_CIRCLE_THICK')),
      profileUrl: canonicalUrl ? `https://www.youtube.com${canonicalUrl}` : `https://www.youtube.com/channel/${channelId}`,
      rawPlatform: 'youtube',
    };
  }

  let token = extractContinuation(data);
  for (let page = 2; page <= 3 && token; page++) {
    try {
      const ctrlP = new AbortController();
      const tP = setTimeout(() => ctrlP.abort(), 20000);
      let pageResp;
      try {
        pageResp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'x-youtube-client-name': '1',
            'x-youtube-client-version': '2.20241201.00.00',
          },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20241201.00.00', hl: 'en', gl: 'US' } },
            continuation: token,
          }),
          signal: ctrlP.signal,
        });
      } finally { clearTimeout(tP); }
      if (!pageResp.ok) break;
      const pageData = await pageResp.json();
      const pageChannels = [];
      function walkPage(node) {
        if (!node || typeof node !== 'object') return;
        if (node.channelRenderer) pageChannels.push(node.channelRenderer);
        for (const v of Object.values(node)) {
          if (Array.isArray(v)) v.forEach(walkPage);
          else if (v && typeof v === 'object') walkPage(v);
        }
      }
      walkPage(pageData);
      for (const ch of pageChannels) {
        const p = buildProfile(ch);
        if (p) profiles.push(p);
      }
      token = extractContinuation(pageData);
      console.log(`[yt-search] page ${page}: ${profiles.length} channels total`);
    } catch (e) {
      console.log(`[yt-search] pagination page ${page} failed: ${e.message}`);
      break;
    }
  }

  console.log(`[yt-search] "${keyword}" → ${profiles.length} channels — enriching in parallel…`);

  // Enrich all found channels in parallel batches of 5 while the caller moves to the next keyword
  const BATCH = 5;
  for (let i = 0; i < profiles.length; i += BATCH) {
    await Promise.all(profiles.slice(i, i + BATCH).map(async p => {
      try {
        const e = await ytEnrichOne(p.handle, p.profileUrl);
        if (e.videoCount)   p.postCount  = e.videoCount;
        if (e.totalViews)   p.totalViews = e.totalViews;
        if (e.country)      p.location   = e.country;
        if (e.description)  p.bio        = e.description;
        if (/^\d/.test(e.subscribers)) p.followers = e.subscribers;
      } catch (err) {
        console.warn(`[yt-enrich] ${p.handle}: ${err.message}`);
      }
    }));
  }

  console.log(`[yt-search] "${keyword}" enrichment complete`);
  return profiles;
}

async function xUserSearch(keyword, _sessionCookies, onProgress = () => {}) {
  // Uses Apify twitter-scraper — no cookie management needed, handles Cloudflare/auth internally.
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) throw new Error('APIFY_API_TOKEN not set — add it to .env.local');

  const tag = keyword.replace(/^#/, '').trim();
  console.log(`[x-apify] starting search for "${tag}"`);
  onProgress({ phase: 'searching', current: 0, total: 200 });

  // 1. Start actor run — apidojo/twitter-scraper searches tweets by keyword/hashtag
  const runResp = await fetch(
    `https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs?token=${apifyToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchTerms:    [`#${tag}`],
        maxItems:       200,
        addUserInfo:    true,
        queryType:      'Latest',
      }),
    }
  );
  const runData = await runResp.json();
  const runId     = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;
  if (!runId) throw new Error(`Apify X run failed to start: ${JSON.stringify(runData)}`);
  console.log(`[x-apify] run started runId=${runId} tag="${tag}"`);

  // 2. Poll until finished
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
  let attempts = 0;
  while (attempts++ < 36) {
    await new Promise(r => setTimeout(r, 5000));
    const sResp  = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
    const sData  = await sResp.json();
    const status = sData?.data?.status;
    const itemCount = sData?.data?.stats?.itemCount ?? 0;
    console.log(`[x-apify] run=${runId} status=${status} items=${itemCount}`);
    onProgress({ phase: 'searching', current: Math.min(itemCount, 200), total: 200 });
    if (status === 'SUCCEEDED') break;
    if (TERMINAL.has(status)) throw new Error(`Apify X run ${status}`);
  }

  // 3. Fetch dataset items
  const itemsResp = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true`
  );
  const items = await itemsResp.json();
  console.log(`[x-apify] dataset=${datasetId} → ${items.length} tweet items`);

  // 4. Group tweets by author, aggregate engagement
  const authorTweets = new Map();
  for (const item of items) {
    const user = item.author || {};
    const handle = user.userName;
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (!authorTweets.has(key)) authorTweets.set(key, { user, tweets: [] });
    authorTweets.get(key).tweets.push({
      caption:  item.fullText || item.text || '',
      likes:    item.likeCount    ?? 0,
      comments: item.replyCount   ?? 0,
      shares:   item.retweetCount ?? 0,
      views:    item.viewCount    ?? 0,
      location: item.place?.full_name || '',
    });
  }

  const profiles = [];
  for (const [, { user, tweets }] of authorTweets) {
    const handle = user.userName;
    if (!handle) continue;

    const totalLikes    = tweets.reduce((s, t) => s + t.likes,    0);
    const totalComments = tweets.reduce((s, t) => s + t.comments, 0);
    const totalViews    = tweets.reduce((s, t) => s + t.views,    0);
    const avgLikes      = tweets.length ? Math.round(totalLikes    / tweets.length) : 0;
    const avgComments   = tweets.length ? Math.round(totalComments / tweets.length) : 0;
    const avgViews      = tweets.length ? Math.round(totalViews    / tweets.length) : 0;
    const followers     = Number(user.followers ?? 0);
    const engagementRate = followers > 0
      ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100
      : 0;

    profiles.push({
      handle,
      fullName:      user.name        || '',
      followers:     String(followers || ''),
      bio:           user.description || '',
      isVerified:    !!(user.isBlueVerified),
      postCount:     String(user.statusesCount ?? ''),
      location:      user.location    || '',
      avatarUrl:     (user.profilePicture || '').replace('_normal', '_400x400'),
      profileUrl:    `https://x.com/${handle}`,
      rawPlatform:   'x',
      platform:      'x',
      hashtagPosts:  tweets.length,
      avgLikes,
      avgComments,
      avgViews,
      engagementRate,
      postCaptions:  tweets.map(t => t.caption).filter(Boolean),
      postLocations: [...new Set(tweets.map(t => t.location).filter(Boolean))],
    });
  }

  console.log(`[x-apify] "${tag}" → ${profiles.length} unique authors`);
  return { profiles, callCount: profiles.length };

}

async function handleBdSearch(req, res) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });

  const { platform, keyword, sessionCookie, sessionCookies, tiktokCookie, xCookie, xCookies, scanRecentFeed } = req.body || {};
  // sessionCookies (array) takes priority; fall back to legacy single-cookie string
  const cookiePool = Array.isArray(sessionCookies) && sessionCookies.length
    ? sessionCookies.filter(Boolean)
    : sessionCookie ? [sessionCookie] : [];
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword is required' });

  const kw = keyword.trim();
  const searchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[bd-search:${platform}] keyword="${kw}" cookies=${cookiePool.length} searchId=${searchId}`);

  updateProgress(searchId, {
    searchId, platform, keyword: kw,
    phase: 'starting', current: 0, total: 0,
    startedAt: Date.now(),
    profiles: null, error: null,
  });

  // Return immediately with searchId — the actual work runs in background
  res.status(200).json({ searchId });

  // Run search in background; client polls /api/verify with action=bd-search-status
  (async () => {
    try {
      const onProgress = (patch) => updateProgress(searchId, patch);
      let result;
      if (platform === 'instagram') {
        result = await igHashtagSearch(kw, cookiePool, onProgress);
      } else if (platform === 'tiktok') {
        onProgress({ phase: 'searching', current: 0, total: 100 });
        result = await ttHashtagSearch(kw, onProgress);
      } else if (platform === 'youtube') {
        onProgress({ phase: 'searching', current: 0, total: 1 });
        result = await ytKeywordSearch(kw);
      } else if (platform === 'x') {
        onProgress({ phase: 'searching', current: 0, total: 1 });
        const xPool = Array.isArray(xCookies) && xCookies.length ? xCookies : (xCookie ? [xCookie] : []);
        result = await xUserSearch(kw, xPool, onProgress);
      }

      let profiles = Array.isArray(result) ? result : (result?.profiles || []);
      const callCount = Array.isArray(result) ? null : result?.callCount;
      const seen = new Set();
      profiles = profiles.filter(p => {
        if (!p.handle || seen.has(p.handle.toLowerCase())) return false;
        seen.add(p.handle.toLowerCase());
        return true;
      });
      const currentProgress = searchProgress.get(searchId) || {};
      const enrichmentBlocked = !!currentProgress.enrichmentBlocked;
      const callNote = callCount != null ? `, ${callCount} API calls` : '';
      console.log(`[bd-search:${platform}] → ${profiles.length} profiles${enrichmentBlocked ? ' (enrichment blocked)' : ''}${callNote} (searchId=${searchId})`);
      updateProgress(searchId, { phase: 'complete', profiles, current: profiles.length, total: profiles.length, enrichmentBlocked, callCount });
    } catch (e) {
      console.error(`[bd-search:${platform}] error:`, e.message, e.cause?.message || '', e.cause?.code || '');
      updateProgress(searchId, { phase: 'error', error: e.message });
    }
  })();
}

async function handleBdSearchStatus(req, res) {
  const { searchId } = req.body || {};
  if (!searchId) return res.status(400).json({ error: 'searchId is required' });
  const p = searchProgress.get(searchId);
  if (!p) return res.status(404).json({ error: 'searchId not found (may have expired)' });
  return res.status(200).json(p);
}

// ── Recent-posts scanner ────────────────────────────────────────────────────
// Fetches each selected profile's recent ~30 posts/videos with per-post engagement via
// the shared fetchers (Apify for IG/TikTok/X, YouTube Data API), persists them to
// profile_posts, and returns a per-handle summary for the UI. No session cookies needed.
async function handleBdScanPosts(req, res) {
  const { profiles, platform, dataset, target } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length)
    return res.status(400).json({ error: 'profiles[] required' });

  const canon = (p) => {
    p = String(p || '').toLowerCase();
    if (p.includes('insta') || p === 'ig') return 'instagram';
    if (p.includes('tik') || p === 'tt') return 'tiktok';
    if (p.includes('you') || p === 'yt') return 'youtube';
    if (p === 'x' || p.includes('twitter')) return 'x';
    return p;
  };
  const lc = (h) => String(h || '').replace(/^@/, '').toLowerCase();

  const scanId = `pscan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  updateProgress(scanId, { phase: 'scanning', current: 0, total: profiles.length });
  res.status(200).json({ scanId });

  (async () => {
    try {
      // Group selected profiles by platform (single platform in normal UI use).
      const groups = {};
      for (const p of profiles) {
        const plat = canon(platform || p.rawPlatform || p.platform);
        (groups[plat] ??= []).push({ handle: p.handle, profileUrl: p.profileUrl || p.profile_url, followers: p.followers });
      }

      const supabase = getSupabase();
      const sourceTable = dataset
        ? (dataset === 'lifestyle'
            ? (target === 'excluded' ? 'lifestyle_bloggers_excluded' : 'lifestyle_bloggers')
            : (target === 'excluded' ? 'brightdata_excluded_profiles' : 'brightdata_profiles'))
        : null;

      const resultsByHandle = new Map();
      let done = 0;

      for (const [plat, arr] of Object.entries(groups)) {
        let map = new Map();
        try {
          map = await fetchPostsForPlatform(plat, arr, {
            onProgress: ({ itemCount }) =>
              updateProgress(scanId, { phase: 'scanning', current: Math.min(done + itemCount, profiles.length), total: profiles.length }),
          });
        } catch (e) {
          console.log(`[scan-posts:${plat}] failed: ${e.message}`);
        }

        for (const prof of arr) {
          const h = lc(prof.handle);
          const posts = map.get(h) || [];
          if (supabase && posts.length) {
            // Dedupe by post_id — the X actor can return the same post twice, and a single upsert
            // batch can't touch the same (handle,platform,post_id) row twice.
            const byId = new Map();
            for (const p of posts) { const r = postToRow(h, plat, p); if (r.post_id) byId.set(r.post_id, r); }
            const rows = [...byId.values()];
            if (rows.length) {
              const { error } = await supabase.from('profile_posts').upsert(rows, { onConflict: 'handle,platform,post_id' });
              if (error) console.log(`[scan-posts] profile_posts upsert ${h}: ${error.message}`);
            }
            if (sourceTable) {
              const agg = computeAggregates(posts, prof.followers);
              const { error } = await supabase.from(sourceTable).update(agg).eq('handle', h).eq('platform', plat);
              if (error) console.log(`[scan-posts] agg ${h}@${sourceTable}: ${error.message}`);
            }
          }
          resultsByHandle.set(h, {
            handle: prof.handle,
            postCaptions: posts.map(p => p.caption).filter(Boolean),
            postLocations: [...new Set(posts.map(p => p.location).filter(Boolean))],
            avgLikes: avgOf(posts, 'likes'),
            avgComments: avgOf(posts, 'comments'),
            avgViews: avgOf(posts, 'views'),
            postCount: posts.length,
          });
          updateProgress(scanId, { phase: 'scanning', current: ++done, total: profiles.length });
        }
      }

      const results = profiles.map(p =>
        resultsByHandle.get(lc(p.handle)) || { handle: p.handle, postCaptions: [], postLocations: [] });
      console.log(`[scan-posts] done — ${results.filter(r => r.postCaptions.length).length}/${profiles.length} had captions`);
      updateProgress(scanId, { phase: 'complete', results, current: profiles.length, total: profiles.length });
    } catch (e) {
      console.log(`[scan-posts] fatal: ${e.message}`);
      updateProgress(scanId, {
        phase: 'complete',
        results: profiles.map(p => ({ handle: p.handle, postCaptions: [], postLocations: [] })),
        current: profiles.length, total: profiles.length, error: e.message,
      });
    }
  })();
}

// ── BrightData Web Scraper API ─────────────────────────────────────────────
// Called when body contains { action: 'brightdata', platform, profiles: [...] }
// Uses the synchronous /datasets/v3/scrape endpoint — one API key, no dataset IDs.
// Docs: https://docs.brightdata.com/api-reference/web-scraper-api/synchronous-requests

const BD_SCRAPE = 'https://api.brightdata.com/datasets/v3/scrape';

// BrightData scraper type per platform
const BD_SCRAPER = {
  instagram: 'instagram-profile-collect-by-url',
  tiktok:    'tiktok-profile-collect-by-url',
  youtube:   'youtube-channel-collect-by-url',
  x:         'x-profile-collect-by-url',
};

function bdProfileUrl(platform, handle) {
  const h = handle.replace(/^@/, '');
  if (platform === 'instagram') return `https://www.instagram.com/${h}/`;
  if (platform === 'tiktok')    return `https://www.tiktok.com/@${h}`;
  if (platform === 'youtube')   return `https://www.youtube.com/@${h}`;
  if (platform === 'x')         return `https://x.com/${h}`;
  return null;
}

// Normalise BrightData response fields into our standard shape.
// Field names are from BrightData's actual API responses.
function bdNormalise(platform, row) {
  if (!row) return null;
  if (platform === 'instagram') return {
    handle:     row.profile_name || row.username || '',
    fullName:   row.name         || row.profile_name || '',
    followers:  String(row.followers   ?? ''),
    bio:        row.biography    || row.description || '',
    postCount:  String(row.posts_count ?? row.posts ?? ''),
    isVerified: !!(row.is_verified || row.verified),
    engagementRate: row.avg_engagement || null,
    profileUrl: row.profile_url  || '',
    rawPlatform: 'instagram',
  };
  if (platform === 'tiktok') return {
    handle:     row.account_id   || row.nickname || '',
    fullName:   row.nickname     || '',
    followers:  String(row.followers ?? ''),
    bio:        row.biography    || row.bio || '',
    postCount:  String(row.videos_count ?? ''),
    isVerified: !!(row.is_verified || row.verified),
    engagementRate: row.awg_engagement_rate || null,
    likes:      String(row.likes ?? ''),
    rawPlatform: 'tiktok',
  };
  if (platform === 'youtube') return {
    handle:     row.channel_name || '',
    fullName:   row.channel_name || '',
    followers:  String(row.subscribers ?? row.subscriber_count ?? ''),
    bio:        row.description  || '',
    postCount:  String(row.video_count ?? ''),
    isVerified: !!(row.verified),
    country:    row.country      || '',
    profileUrl: row.url          || '',
    rawPlatform: 'youtube',
  };
  if (platform === 'x') return {
    handle:     row.username     || row.screen_name || '',
    fullName:   row.name         || '',
    followers:  String(row.followers ?? row.followers_count ?? ''),
    bio:        row.description  || row.bio || '',
    postCount:  String(row.posts ?? row.statuses_count ?? ''),
    isVerified: !!(row.verified  || row.is_blue_verified),
    location:   row.location     || '',
    rawPlatform: 'x',
  };
  return null;
}

async function handleBrightData(req, res) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });

  const { platform, profiles } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  if (!Array.isArray(profiles) || !profiles.length) return res.status(400).json({ error: 'profiles[] is required' });

  const scraperType = BD_SCRAPER[platform];
  const input = profiles
    .map(p => ({ url: bdProfileUrl(platform, p) }))
    .filter(r => r.url);

  let rawRows;
  try {
    const resp = await fetch(`${BD_SCRAPE}?scraper=${scraperType}&format=json`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    // 202 = async job started, returns snapshot_id
    if (resp.status === 202) {
      const asyncData = await resp.json();
      const snapshotId = asyncData.snapshot_id;
      if (!snapshotId) return res.status(502).json({ error: 'BrightData returned 202 but no snapshot_id', raw: asyncData });
      console.log(`[brightdata:${platform}] async snapshot: ${snapshotId}, polling…`);

      // Poll for result
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 4000));
        const pollResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (pollResp.status === 202) continue;
        if (!pollResp.ok) {
          const txt = await pollResp.text().catch(() => '');
          return res.status(502).json({ error: `Snapshot poll failed: HTTP ${pollResp.status} — ${txt.slice(0, 200)}` });
        }
        const text = await pollResp.text();
        try { rawRows = JSON.parse(text); } catch {
          rawRows = text.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
        break;
      }
      if (!rawRows) return res.status(504).json({ error: 'BrightData snapshot timed out', snapshot_id: snapshotId });
    } else if (resp.ok) {
      // Synchronous response
      const text = await resp.text();
      try { rawRows = JSON.parse(text); } catch {
        rawRows = text.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
    } else {
      const errText = await resp.text().catch(() => '');
      return res.status(502).json({ error: `BrightData error: HTTP ${resp.status}`, detail: errText.slice(0, 300) });
    }
  } catch (e) {
    return res.status(502).json({ error: `BrightData request failed: ${e.message}` });
  }

  if (!Array.isArray(rawRows)) rawRows = [rawRows].filter(Boolean);
  console.log(`[brightdata:${platform}] ${rawRows.length} rows returned`);

  // Normalise and key by original handle
  const results = {};
  for (let i = 0; i < profiles.length; i++) {
    const handle = profiles[i].replace(/^@/, '').toLowerCase();
    const row = rawRows[i] || rawRows.find(r =>
      (r.profile_name || r.username || r.account_id || r.unique_id || r.screen_name || r.channel_name || '')
        .toLowerCase() === handle
    );
    if (!row) { results[profiles[i]] = { error: 'not_found' }; continue; }
    if (row.error || row.status === 'failed') { results[profiles[i]] = { error: row.error || row.message || 'scrape_failed' }; continue; }
    results[profiles[i]] = bdNormalise(platform, row) || { error: 'normalise_failed' };
  }

  return res.status(200).json({ results });
}

// ── YouTube channel enrichment (manual button — synchronous, no polling) ─────
// Runs all enrichment in parallel batches and returns results directly.
// Avoids Vercel's 10s function timeout that killed the old background-task approach.
async function handleYtEnrich(req, res) {
  const { profiles } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length)
    return res.status(400).json({ error: 'profiles[] required' });

  const BATCH = 8;
  const results = [];
  for (let i = 0; i < profiles.length; i += BATCH) {
    await Promise.all(profiles.slice(i, i + BATCH).map(async ({ handle, profileUrl }) => {
      try {
        const e = await ytEnrichOne(handle, profileUrl);
        results.push({
          handle, enriched: true,
          postCount:  e.videoCount,
          totalViews: e.totalViews,
          followers:  /^\d/.test(e.subscribers) ? e.subscribers : '',
          location:   e.country,
          bio:        e.description || undefined,
        });
      } catch (e) {
        console.warn(`[yt-enrich] ${handle}: ${e.message}`);
        results.push({ handle, enriched: false });
      }
    }));
  }
  return res.status(200).json({ results });
}
