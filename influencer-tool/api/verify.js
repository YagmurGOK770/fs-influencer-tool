// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Returns live follower count, bio, verified status for each handle.
//
// Instagram, TikTok, X: routed through BrightData Web Unlocker to avoid 429s.
// YouTube: public, fetched directly (no blocking issues).

import { checkAuth } from './_auth.js';
import { createClient } from '@supabase/supabase-js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

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
async function verifyInstagram(username) {
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
async function verifyTikTok(username, cookieRaw) {
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
async function verifyYouTube(username) {
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
async function verifyX(username) {
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
  if ((req.body || {}).action === 'bd-reenrich') {
    return handleBdReenrich(req, res);
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

async function igHashtagSearch(keyword, sessionCookies, onProgress = () => {}) {
  const tag = keyword.replace(/^#/, '').toLowerCase().trim();

  // Accept a single cookie string or an array; filter empties
  const cookies = (Array.isArray(sessionCookies) ? sessionCookies : [sessionCookies]).filter(Boolean);
  if (!cookies.length) {
    throw new Error('Instagram session cookie required. Paste your sessionid= cookie in the search panel.');
  }

  const PAGES_PER_COOKIE = 3; // rotate to next account every N pagination pages
  const MAX_PAGES        = 15;

  function buildCookieHeader(raw) {
    return raw.includes('sessionid=') ? raw : `sessionid=${raw}`;
  }
  function csrfFor(raw) {
    const m = buildCookieHeader(raw).match(/csrftoken=([^;]+)/);
    return m ? m[1].trim() : '';
  }
  // Which cookie to use for a given pagination page (1-based)
  function cookieForPage(pageNum) {
    return cookies[Math.floor((pageNum - 1) / PAGES_PER_COOKIE) % cookies.length];
  }
  // Which cookie to use for the i-th profile enrichment (0-based)
  function cookieForEnrich(i) {
    return cookies[i % cookies.length];
  }

  // Human-like jittered delay: returns a Promise that resolves after random ms in [minMs, maxMs]
  const sleep = (minMs, maxMs) => new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));

  // Routing priority for cookie-authenticated calls:
  //   1. BrightData residential proxy (BRIGHTDATA_PROXY_URL set) — raw TCP tunnel, cookies pass through intact
  //   2. Direct fetch from local IP (fallback)
  // NOTE: Web Unlocker is intentionally skipped here — it manages its own sessions and strips/overrides
  // our cookie header, causing Instagram to see an unauthenticated request and return HTML.
  const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
  const proxyDispatcher = proxyUrl ? new ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized: false },
    proxyTls:   { rejectUnauthorized: false },
  }) : null;

  if (proxyDispatcher) console.log('[ig-search] routing via BrightData residential proxy');
  else                 console.log('[ig-search] routing direct (no proxy configured)');

  let callCount = 0;

  // Build request headers for a specific raw cookie string
  const igHeaders = (cookieRaw, extraHeaders = {}) => ({
    'x-ig-app-id': '936619743392459',
    'x-csrftoken': csrfFor(cookieRaw),
    'x-requested-with': 'XMLHttpRequest',
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'referer': 'https://www.instagram.com/explore/tags/' + tag + '/',
    'origin': 'https://www.instagram.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'cookie': buildCookieHeader(cookieRaw),
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...extraHeaders,
  });

  // opts.cookieRaw overrides which account's cookie is used for this call
  async function igDirect(url, opts = {}) {
    callCount++;
    const cookieRaw = opts.cookieRaw || cookies[0];
    const headers = igHeaders(cookieRaw, opts.headers || {});
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const fetcher = proxyDispatcher ? undiciFetch : fetch;
    try {
      return await fetcher(url, {
        method: opts.method || 'GET',
        body: opts.body,
        headers,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
  }

  // Step 1: fetch hashtag top posts via web_info
  // Verified working: returns data.top.sections[].layout_content.medias[].media.user
  // user fields: pk, username, full_name, is_verified (no follower_count here)
  onProgress({ phase: 'fetching-page', page: 1, current: 0, total: 0, cookieIdx: 0 });
  const infoResp = await igDirect(`https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`, { cookieRaw: cookieForPage(1) });
  const infoText = await infoResp.text();
  console.log(`[ig-search] web_info status=${infoResp.status} len=${infoText.length}`);

  if (!infoResp.ok) throw new Error(`Instagram HTTP ${infoResp.status} — cookie may be expired`);
  if (!infoText.trim()) throw new Error(`Instagram returned empty body — cookie may be invalid`);

  let infoJson;
  try { infoJson = JSON.parse(infoText); } catch (_) {
    // Instagram serving HTML = IP/session blocked. Give a clear actionable message.
    throw new Error(`Instagram is blocking requests from this session — wait 1–2 hours, refresh your session cookie, and try again`);
  }

  // Extract every media object (with user) from a section's layout_content.
  // layout_content uses varying keys (medias, fill_items, one_by_two_item, etc.)
  function extractMedias(layoutContent) {
    const out = [];
    for (const val of Object.values(layoutContent || {})) {
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        const m = item?.media;
        if (m?.user?.username) out.push(m);
      }
    }
    return out;
  }

  const seen = new Set();
  const userStubs = [];
  // username → array of { likes, comments, taken_at } for posts that matched this hashtag
  const userPosts = new Map();

  function harvestSections(sections) {
    let added = 0;
    for (const section of sections || []) {
      for (const m of extractMedias(section.layout_content)) {
        const u = m.user;
        if (!seen.has(u.username)) {
          seen.add(u.username);
          userStubs.push({ pk: u.pk || u.id, username: u.username, full_name: u.full_name || '', is_verified: !!(u.is_verified) });
          added++;
        }
        const posts = userPosts.get(u.username) || [];
        posts.push({
          pk:       m.pk || m.id,
          likes:    Number(m.like_count    ?? 0),
          comments: Number(m.comment_count ?? 0),
          taken_at: m.taken_at,
          caption:  (m.caption?.text || '').slice(0, 800),
          location: m.location?.name || '',
        });
        userPosts.set(u.username, posts);
      }
    }
    return added;
  }

  // Page 1: from web_info top sections
  const topRoot = infoJson?.data?.top || {};
  harvestSections(topRoot.sections);
  console.log(`[ig-search] page 1: ${userStubs.length} unique authors`);
  onProgress({ phase: 'paginating', page: 1, current: userStubs.length, total: userStubs.length });

  // Pages 2+: paginate via /api/v1/tags/{tag}/sections/ POST
  // Rotate cookie every PAGES_PER_COOKIE pages to spread session load across accounts
  let nextMaxId = topRoot.next_max_id;
  let nextPage = topRoot.next_page;
  let moreAvailable = !!topRoot.more_available;

  let paginationStopReason = 'reached MAX_PAGES limit';
  for (let p = 2; p <= MAX_PAGES && moreAvailable && nextMaxId; p++) {
    const baseCookieIdx = Math.floor((p - 1) / PAGES_PER_COOKIE) % cookies.length;
    onProgress({ phase: 'fetching-page', page: p, current: userStubs.length, total: userStubs.length, cookieIdx: baseCookieIdx });
    await sleep(2000, 4000); // mimic scroll pause

    const body = new URLSearchParams({
      include_persistent: 'true',
      max_id: nextMaxId,
      page: String(nextPage ?? p - 1),
      surface: 'grid',
      tab: 'top',
    }).toString();

    // Try each cookie in round-robin order until one succeeds (handles 502/429 per account)
    let r = null, pageCookieIdx = baseCookieIdx;
    for (let attempt = 0; attempt < cookies.length; attempt++) {
      pageCookieIdx = (baseCookieIdx + attempt) % cookies.length;
      const acctTry = cookies.length > 1 ? ` [acct ${pageCookieIdx + 1}/${cookies.length}]` : '';
      try {
        r = await igDirect(`https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/sections/`, {
          method: 'POST', body, cookieRaw: cookies[pageCookieIdx],
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        if (r.ok) break; // success — use this response
        console.log(`[ig-search] page ${p}${acctTry} HTTP ${r.status}${attempt < cookies.length - 1 ? ', retrying with next account…' : ', no more accounts to try'}`);
        r = null;
        if (attempt < cookies.length - 1) await sleep(1000, 2000);
      } catch (e) {
        console.log(`[ig-search] page ${p}${acctTry} error: ${e.message}${attempt < cookies.length - 1 ? ', retrying…' : ''}`);
        r = null;
      }
    }

    if (!r) { paginationStopReason = 'all accounts failed on page ' + p; break; }

    const j = await r.json().catch(() => null);
    if (!j) { console.log(`[ig-search] page ${p} non-JSON response, stopping`); paginationStopReason = 'non-JSON response'; break; }

    const acctTag = cookies.length > 1 ? ` [acct ${pageCookieIdx + 1}/${cookies.length}]` : '';
    const added = harvestSections(j.sections);
    moreAvailable = !!j.more_available;
    nextMaxId = j.next_max_id;
    nextPage = j.next_page;
    console.log(`[ig-search] page ${p}${acctTag}: +${added} new authors (total ${userStubs.length})`);
    onProgress({ phase: 'paginating', page: p, current: userStubs.length, total: userStubs.length, cookieIdx: pageCookieIdx });
    if (!moreAvailable) { paginationStopReason = 'Instagram more_available=false'; }
    if (!nextMaxId)      { paginationStopReason = 'no next_max_id cursor'; }
    if (added === 0)     { paginationStopReason = '0 new unique authors'; break; }
  }

  console.log(`[ig-search] pagination done — ${paginationStopReason} · ${userStubs.length} unique authors collected`);

  if (userStubs.length === 0) return [];

  // Step 2: enrich each author with follower_count + biography via /api/v1/users/{pk}/info/
  // Sequential with 600-1400ms jittered delay (mimics human profile browsing)
  // Rotates through cookie pool per profile to spread enrichment load across accounts
  async function fetchProfile(stub, cookieRaw) {
    try {
      const r = await igDirect(`https://www.instagram.com/api/v1/users/${stub.pk}/info/`, { cookieRaw });
      if (!r.ok) return null;
      const bodyText = await r.text().catch(() => '');
      let j;
      try { j = JSON.parse(bodyText); } catch (_) {
        // Instagram returned HTML — rate-limited or IP-blocked on this endpoint
        return { __rateLimited: true };
      }
      const u = j?.user;
      if (!u) return null;

      const allPosts   = userPosts.get(stub.username) || [];
      const postsCount = allPosts.length;
      const totalLikes    = allPosts.reduce((s, p) => s + (p.likes    || 0), 0);
      const totalComments = allPosts.reduce((s, p) => s + (p.comments || 0), 0);
      const avgLikes    = postsCount ? Math.round(totalLikes    / postsCount) : 0;
      const avgComments = postsCount ? Math.round(totalComments / postsCount) : 0;
      const followers   = Number(u.follower_count) || 0;
      const engagementRate = followers > 0
        ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100
        : 0;

      // Aggregate post content for filtering
      const postCaptions  = allPosts.map(p => p.caption).filter(Boolean);
      const postLocations = [...new Set(allPosts.map(p => p.location).filter(Boolean))];

      return {
        handle:         u.username || stub.username,
        pk:             String(stub.pk),
        fullName:       u.full_name || stub.full_name,
        followers:      String(u.follower_count ?? ''),
        bio:            u.biography || '',
        isVerified:     !!(u.is_verified ?? stub.is_verified),
        postCount:      String(u.media_count ?? ''),
        profileUrl:     `https://www.instagram.com/${stub.username}/`,
        rawPlatform:    'instagram',
        hashtagPosts:   postsCount,
        avgLikes,
        avgComments,
        engagementRate,
        postCaptions,
        postLocations,
      };
    } catch (_) { return null; }
  }

  function stubProfile(s) {
    const ap = userPosts.get(s.username) || [];
    const pc = ap.length;
    const tl = ap.reduce((sum, p) => sum + (p.likes    || 0), 0);
    const tc = ap.reduce((sum, p) => sum + (p.comments || 0), 0);
    return {
      handle: s.username, pk: String(s.pk), fullName: s.full_name || '',
      followers: '', bio: '', isVerified: !!s.is_verified, postCount: '',
      profileUrl: `https://www.instagram.com/${s.username}/`,
      rawPlatform: 'instagram', hashtagPosts: pc,
      avgLikes: pc ? Math.round(tl / pc) : 0, avgComments: pc ? Math.round(tc / pc) : 0,
      engagementRate: 0,
      postCaptions: ap.map(p => p.caption).filter(Boolean),
      postLocations: [...new Set(ap.map(p => p.location).filter(Boolean))],
    };
  }

  const profiles = [];
  let rateLimitedCount = 0;
  onProgress({ phase: 'enriching', current: 0, total: userStubs.length, cookieIdx: 0 });
  for (let i = 0; i < userStubs.length; i++) {
    const stub = userStubs[i];
    const enrichCookieIdx = i % cookies.length;
    const result = await fetchProfile(stub, cookieForEnrich(i));
    if (result && !result.__rateLimited) {
      profiles.push(result);
    } else {
      if (result?.__rateLimited) rateLimitedCount++;
      if (rateLimitedCount >= 3 && i < 5) {
        console.log(`[ig-search] enrichment blocked (HTML responses) — returning stubs only`);
        onProgress({ phase: 'enriching', current: userStubs.length, total: userStubs.length, enrichmentBlocked: true });
        for (let j = i; j < userStubs.length; j++) profiles.push(stubProfile(userStubs[j]));
        break;
      }
      profiles.push(stubProfile(stub));
    }
    onProgress({ phase: 'enriching', current: i + 1, total: userStubs.length, cookieIdx: enrichCookieIdx });
    if (i < userStubs.length - 1) await sleep(600, 1400);
    if ((i + 1) % 20 === 0) console.log(`[ig-search] enriched ${i + 1}/${userStubs.length}`);
  }

  console.log(`[ig-search] #${tag} → ${profiles.length} profiles (${profiles.filter(p => p.followers).length} fully enriched, ${callCount} API calls)`);
  return { profiles, callCount };
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
  for (const ch of channels) {
    const channelId = ch.channelId || ch.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);

    // Prefer @handle from canonicalBaseUrl (e.g. "/@FoodChannel") over raw channel ID
    const canonicalUrl = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    const atMatch = canonicalUrl.match(/^\/@(.+)$/);
    const handle = atMatch ? atMatch[1] : channelId;

    // BrightData sometimes swaps subscriberCountText / videoCountText field values.
    // Always validate: a subscriber count must contain at least one digit.
    const subRaw = ch.subscriberCountText?.simpleText
      || ch.subscriberCountText?.runs?.map(r => r.text).join('')
      || '';
    const subCleaned = subRaw.replace(/\s*subscribers?/i, '').trim();
    const followers  = /\d/.test(subCleaned) ? subCleaned : '';

    const videoRaw   = ch.videoCountText?.runs?.map(r => r.text).join('') || ch.videoCountText?.simpleText || '';
    // Don't store subscriber-like text as post count
    const postCount  = /subscriber/i.test(videoRaw) ? '' : videoRaw;

    const profileUrl = canonicalUrl
      ? `https://www.youtube.com${canonicalUrl}`
      : `https://www.youtube.com/channel/${channelId}`;

    profiles.push({
      handle,
      fullName:    ch.title?.simpleText || ch.title?.runs?.map(r => r.text).join('') || '',
      followers,
      bio:         ch.descriptionSnippet?.runs?.map(r => r.text).join('') || '',
      isVerified:  !!(ch.ownerBadges?.some(b =>
        b?.metadataBadgeRenderer?.style?.includes('VERIFIED') ||
        b?.metadataBadgeRenderer?.icon?.iconType === 'CHECK_CIRCLE_THICK'
      )),
      postCount,
      profileUrl,
      rawPlatform: 'youtube',
    });
  }
  console.log(`[yt-search] "${keyword}" → ${profiles.length} channels`);
  return profiles;
}

async function xUserSearch(keyword) {
  // X search page with f=user — parse __NEXT_DATA__ embedded server-side
  const resp = await bdFetch(
    `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=user`,
    {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    30000
  );
  if (!resp.ok) throw new Error(`X search HTTP ${resp.status}`);
  const html = await resp.text();
  const profiles = [];
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const timeline = data?.props?.pageProps?.timeline_response?.timeline;
      const entries = (timeline?.instructions || []).flatMap(i => i.entries || i.addEntries?.entries || []);
      for (const entry of entries) {
        const ur = entry?.content?.itemContent?.user_results?.result;
        const user = ur?.legacy;
        if (!user?.screen_name) continue;
        profiles.push({
          handle:     user.screen_name,
          fullName:   user.name || '',
          followers:  String(user.followers_count ?? ''),
          bio:        user.description || '',
          isVerified: !!(ur?.is_blue_verified || user.verified),
          postCount:  String(user.statuses_count ?? ''),
          location:   user.location || '',
          profileUrl: `https://x.com/${user.screen_name}`,
          rawPlatform: 'x',
        });
      }
    } catch (_) { /* skip */ }
  }
  console.log(`[x-search] "${keyword}" → ${profiles.length} users, htmlLen=${html.length}`);
  return profiles;
}

async function handleBdSearch(req, res) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });

  const { platform, keyword, sessionCookie, sessionCookies, tiktokCookie, scanRecentFeed } = req.body || {};
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
        result = await xUserSearch(kw);
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

// ── Re-enrichment: fetch profile info for stubs missing followers/bio ──────
async function handleBdReenrich(req, res) {
  const { profiles, sessionCookie, sessionCookies } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length)
    return res.status(400).json({ error: 'profiles[] required' });
  const cookies = Array.isArray(sessionCookies) && sessionCookies.length
    ? sessionCookies.filter(Boolean)
    : sessionCookie ? [sessionCookie] : [];
  if (!cookies.length)
    return res.status(400).json({ error: 'sessionCookie required' });

  const scanId = `reenrich-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  updateProgress(scanId, { phase: 'enriching', current: 0, total: profiles.length });
  res.status(200).json({ scanId });

  (async () => {
    const sleep = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
    const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
    const proxyDispatcher = proxyUrl ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
      proxyTls:   { rejectUnauthorized: false },
    }) : null;

    const igGet = (url, cookieRaw) => {
      const cookieHeader = cookieRaw.includes('sessionid=') ? cookieRaw : `sessionid=${cookieRaw}`;
      const csrfToken = (cookieHeader.match(/csrftoken=([^;]+)/) || [])[1]?.trim() || '';
      return (proxyDispatcher ? undiciFetch : fetch)(url, {
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-csrftoken': csrfToken,
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          'origin': 'https://www.instagram.com',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'cookie': cookieHeader,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      });
    };

    const results = [];
    let htmlCount = 0;
    for (let i = 0; i < profiles.length; i++) {
      const { handle, pk } = profiles[i];
      const cookieRaw = cookies[i % cookies.length];
      const acctTag = cookies.length > 1 ? ` [acct ${(i % cookies.length) + 1}/${cookies.length}]` : '';
      try {
        if (!pk) throw new Error('no pk');
        const r = await igGet(`https://www.instagram.com/api/v1/users/${pk}/info/`, cookieRaw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bodyText = await r.text().catch(() => '');
        let j;
        try { j = JSON.parse(bodyText); } catch (_) {
          htmlCount++;
          if (htmlCount >= 3) {
            console.log(`[ig-reenrich] session blocked (HTML responses) — stopping early`);
            results.push({ handle, enriched: false });
            updateProgress(scanId, { phase: 'complete', results, blocked: true, current: profiles.length, total: profiles.length });
            return;
          }
          throw new Error('non-JSON (rate-limited)');
        }
        const u = j?.user;
        if (!u) throw new Error('no user object');
        const followers = Number(u.follower_count) || 0;
        results.push({
          handle,
          followers:      String(u.follower_count ?? ''),
          fullName:       u.full_name || '',
          bio:            u.biography || '',
          isVerified:     !!u.is_verified,
          postCount:      String(u.media_count ?? ''),
          enriched:       true,
        });
        console.log(`[ig-reenrich] ${handle}${acctTag} → ${followers} followers`);
      } catch (e) {
        if (i === 0) console.log(`[ig-reenrich] ${handle}${acctTag} failed: ${e.message}`);
        results.push({ handle, enriched: false });
      }
      updateProgress(scanId, { phase: 'enriching', current: i + 1, total: profiles.length });
      if (i < profiles.length - 1) await sleep(600, 1400);
    }

    const enriched = results.filter(r => r.enriched).length;
    console.log(`[ig-reenrich] done — ${enriched}/${profiles.length} enriched`);
    updateProgress(scanId, { phase: 'complete', results, current: profiles.length, total: profiles.length });
  })();
}

// ── TikTok post scanner via Apify ─────────────────────────────────────────
async function ttApifyScanPosts(profiles, onProgress) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not configured');

  const usernames = profiles.map(p => p.handle.replace(/^@/, ''));

  const apifyJson = async (url, opts = {}) => {
    const r = await fetch(url, opts);
    const text = await r.text();
    try { return JSON.parse(text); }
    catch (_) { throw new Error(`Apify HTTP ${r.status}: ${text.slice(0, 200)}`); }
  };

  const runData = await apifyJson(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profiles: usernames,
        resultsPerPage: 20,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      }),
    }
  );
  const runId = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;
  if (!runId) throw new Error(`Apify start failed: ${JSON.stringify(runData)}`);
  console.log(`[tt-scan-posts] Apify run ${runId} started for ${usernames.length} profiles`);

  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    const sData = await apifyJson(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const status = sData?.data?.status;
    const itemCount = sData?.data?.stats?.itemCount ?? 0;
    onProgress({ phase: 'scanning', current: Math.min(itemCount, profiles.length), total: profiles.length });
    if (status === 'SUCCEEDED') break;
    if (TERMINAL.has(status)) throw new Error(`Apify run ${status}: ${JSON.stringify(sData?.data?.statusMessage ?? '')}`);
  }

  const items = await apifyJson(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`);
  console.log(`[tt-scan-posts] dataset has ${items.length} videos`);

  // Group videos by author handle
  const byAuthor = new Map();
  for (const item of items) {
    const handle = (item.authorMeta?.name || item.author?.uniqueId || '').toLowerCase();
    if (!handle) continue;
    if (!byAuthor.has(handle)) byAuthor.set(handle, { meta: item.authorMeta || {}, videos: [] });
    byAuthor.get(handle).videos.push({
      caption:  item.text || item.desc || '',
      likes:    item.diggCount   ?? item.stats?.diggCount   ?? 0,
      comments: item.commentCount ?? item.stats?.commentCount ?? 0,
      shares:   item.shareCount  ?? item.stats?.shareCount  ?? 0,
      views:    item.playCount   ?? item.stats?.playCount   ?? 0,
      location: item.locationCreated?.city || item.locationCreated?.country || '',
    });
  }

  const results = [];
  for (const profile of profiles) {
    const key = profile.handle.replace(/^@/, '').toLowerCase();
    const entry = byAuthor.get(key);
    if (!entry) {
      console.log(`[tt-scan-posts] ${profile.handle} — no videos in dataset`);
      results.push({ handle: profile.handle, postCaptions: [], postLocations: [], avgLikes: 0, avgComments: 0, avgViews: 0 });
      continue;
    }
    const { videos } = entry;
    const avgLikes    = videos.length ? Math.round(videos.reduce((s,v) => s + v.likes, 0)    / videos.length) : 0;
    const avgComments = videos.length ? Math.round(videos.reduce((s,v) => s + v.comments, 0) / videos.length) : 0;
    const avgViews    = videos.length ? Math.round(videos.reduce((s,v) => s + v.views, 0)    / videos.length) : 0;
    console.log(`[tt-scan-posts] ${profile.handle} → ${videos.length} videos`);
    results.push({
      handle:        profile.handle,
      postCaptions:  videos.map(v => v.caption).filter(Boolean),
      postLocations: [...new Set(videos.map(v => v.location).filter(Boolean))],
      avgLikes, avgComments, avgViews,
    });
  }
  return results;
}

// ── Post scanner: fetches recent feed per profile (separate step, not part of search) ──
async function handleBdScanPosts(req, res) {
  const { profiles, sessionCookie, sessionCookies } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length)
    return res.status(400).json({ error: 'profiles[] required' });

  // TikTok profiles use Apify — no session cookie required
  const isTikTok = profiles.every(p => p.rawPlatform === 'tiktok');
  const cookies = Array.isArray(sessionCookies) && sessionCookies.length
    ? sessionCookies.filter(Boolean)
    : sessionCookie ? [sessionCookie] : [];
  if (!isTikTok && !cookies.length)
    return res.status(400).json({ error: 'sessionCookie required' });

  const scanId = `pscan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  updateProgress(scanId, { phase: 'scanning', current: 0, total: profiles.length });
  res.status(200).json({ scanId });

  (async () => {
    // TikTok: delegate entirely to Apify
    if (isTikTok) {
      try {
        const results = await ttApifyScanPosts(profiles, prog =>
          updateProgress(scanId, { ...prog, total: profiles.length })
        );
        console.log(`[tt-scan-posts] done — ${results.filter(r => r.postCaptions.length).length}/${profiles.length} had captions`);
        updateProgress(scanId, { phase: 'complete', results, current: profiles.length, total: profiles.length });
      } catch (e) {
        console.log(`[tt-scan-posts] fatal: ${e.message}`);
        updateProgress(scanId, { phase: 'complete', results: profiles.map(p => ({ handle: p.handle, postCaptions: [], postLocations: [] })), current: profiles.length, total: profiles.length, error: e.message });
      }
      return;
    }

    const sleep = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
    const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
    const proxyDispatcher = proxyUrl ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
      proxyTls:   { rejectUnauthorized: false },
    }) : null;
    const igGet = (url, cookieRaw) => {
      const cookieHeader = cookieRaw.includes('sessionid=') ? cookieRaw : `sessionid=${cookieRaw}`;
      const csrfToken = (cookieHeader.match(/csrftoken=([^;]+)/) || [])[1]?.trim() || '';
      return (proxyDispatcher ? undiciFetch : fetch)(url, {
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-csrftoken': csrfToken,
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          'origin': 'https://www.instagram.com',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'cookie': cookieHeader,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      });
    };

    const results = [];
    let htmlCount = 0;
    for (let i = 0; i < profiles.length; i++) {
      const { handle, pk } = profiles[i];
      const cookieRaw = cookies[i % cookies.length];
      const acctTag = cookies.length > 1 ? ` [acct ${(i % cookies.length) + 1}/${cookies.length}]` : '';
      try {
        if (!pk) throw new Error('no pk');
        const r = await igGet(`https://www.instagram.com/api/v1/feed/user/${pk}/?count=12`, cookieRaw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bodyText = await r.text().catch(() => '');
        let j;
        try { j = JSON.parse(bodyText); } catch (_) {
          htmlCount++;
          if (htmlCount >= 3) {
            console.log(`[ig-scan-posts] session blocked (HTML responses) — stopping early`);
            results.push({ handle, postCaptions: [], postLocations: [] });
            updateProgress(scanId, { phase: 'complete', results, blocked: true, current: profiles.length, total: profiles.length });
            return;
          }
          throw new Error('non-JSON response (rate-limited)');
        }
        const items = j?.items || [];
        results.push({
          handle,
          postCaptions:  items.map(m => (m.caption?.text || '').slice(0, 800)).filter(Boolean),
          postLocations: [...new Set(items.map(m => m.location?.name || '').filter(Boolean))],
        });
        console.log(`[ig-scan-posts] ${handle}${acctTag} → ${items.length} posts`);
      } catch (e) {
        console.log(`[ig-scan-posts] ${handle}${acctTag} failed: ${e.message}`);
        results.push({ handle, postCaptions: [], postLocations: [] });
      }
      updateProgress(scanId, { phase: 'scanning', current: i + 1, total: profiles.length });
      if (i < profiles.length - 1) await sleep(600, 1400);
    }

    console.log(`[ig-scan-posts] done — ${results.filter(r => r.postCaptions.length).length}/${profiles.length} had captions`);
    updateProgress(scanId, { phase: 'complete', results, current: profiles.length, total: profiles.length });
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
