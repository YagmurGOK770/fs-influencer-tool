// POST /api/verify
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', handles: ['@user1', ...] }
// Returns live follower count, bio, verified status for each handle.
//
// Instagram, TikTok, X: routed through BrightData Web Unlocker to avoid 429s.
// YouTube: public, fetched directly (no blocking issues).

import { checkAuth } from './_auth.js';
import { createClient } from '@supabase/supabase-js';

// ── BrightData Web Unlocker ────────────────────────────────────────────────
// Routes a request through BrightData Web Unlocker and returns the response text.
// Falls back to direct fetch if BRIGHTDATA_API_TOKEN / BRIGHTDATA_ZONE not set.
async function bdFetch(targetUrl, reqHeaders = {}, ms = 20000) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone  = process.env.BRIGHTDATA_ZONE || 'influencer_proxy1';

  if (!token) {
    // Fallback: direct fetch (may get 429 on Vercel)
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(targetUrl, { headers: reqHeaders, signal: ctrl.signal });
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
        format: 'raw',
        headers: reqHeaders,
      }),
      signal: ctrl.signal,
    });
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
async function verifyTikTok(username) {
  try {
    const resp = await bdFetch(
      `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(username)}&aid=1988&app_language=en&app_name=tiktok_web`,
      {
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://www.tiktok.com/',
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
// Fetches the platform's hashtag/search page via Web Unlocker and extracts profiles.

// ── Instagram hashtag search via internal API ──────────────────────────────
// Step 1: resolve hashtag name → numeric ID
// Step 2: fetch recent media for that tag → collect unique authors
// Authors don't include follower counts here, so we return handles and
// then the caller can run verify on them — or we do a quick profile lookup.

const IG_APP_ID = '936619743392459';

async function igHashtagSearch(keyword) {
  const tag = keyword.replace(/^#/, '').toLowerCase().trim();

  // Step 1: get hashtag ID
  const idResp = await bdFetch(
    `https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(tag)}`,
    { 'x-ig-app-id': IG_APP_ID, 'accept': '*/*', 'referer': 'https://www.instagram.com/' }
  );
  if (!idResp.ok) throw new Error(`hashtag search HTTP ${idResp.status}`);
  const idJson = await idResp.json();
  // Response: { results: [{ id, name, media_count, ... }] }
  const tagObj = (idJson.results || []).find(r => r.name?.toLowerCase() === tag) || idJson.results?.[0];
  if (!tagObj?.id) throw new Error('Hashtag not found on Instagram');
  const tagId = tagObj.id;

  // Step 2: fetch recent media for this tag
  const mediaResp = await bdFetch(
    `https://www.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&tab_type=recent`,
    { 'x-ig-app-id': IG_APP_ID, 'accept': '*/*', 'referer': `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/` }
  );
  if (!mediaResp.ok) throw new Error(`hashtag feed HTTP ${mediaResp.status}`);
  const mediaJson = await mediaResp.json();

  // Also fetch top posts
  const topResp = await bdFetch(
    `https://www.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&tab_type=top`,
    { 'x-ig-app-id': IG_APP_ID, 'accept': '*/*', 'referer': `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/` }
  );
  const topJson = topResp.ok ? await topResp.json().catch(() => ({})) : {};

  const allItems = [
    ...(mediaJson.items || []),
    ...(topJson.items || []),
  ];

  const seen = new Set();
  const profiles = [];
  for (const item of allItems) {
    const u = item.user || item.owner;
    if (!u?.username || seen.has(u.username)) continue;
    seen.add(u.username);
    profiles.push({
      handle:     u.username,
      fullName:   u.full_name || '',
      followers:  String(u.follower_count ?? u.edge_followed_by?.count ?? ''),
      bio:        u.biography || '',
      isVerified: !!(u.is_verified),
      postCount:  String(u.media_count ?? u.edge_owner_to_timeline_media?.count ?? ''),
      profileUrl: `https://www.instagram.com/${u.username}/`,
      rawPlatform: 'instagram',
    });
  }
  return profiles;
}

// ── TikTok hashtag search via internal API ─────────────────────────────────
async function ttHashtagSearch(keyword) {
  const tag = keyword.replace(/^#/, '').trim();
  // Step 1: get challengeID for this hashtag
  const challengeResp = await bdFetch(
    `https://www.tiktok.com/api/challenge/detail/?challengeName=${encodeURIComponent(tag)}&aid=1988&app_language=en`,
    { 'accept': 'application/json', 'referer': 'https://www.tiktok.com/' }
  );
  if (!challengeResp.ok) throw new Error(`TikTok challenge HTTP ${challengeResp.status}`);
  const challengeJson = await challengeResp.json();
  const challengeId = challengeJson?.challengeInfo?.challenge?.id;
  if (!challengeId) throw new Error('Hashtag not found on TikTok');

  // Step 2: fetch videos for this challenge
  const feedResp = await bdFetch(
    `https://www.tiktok.com/api/challenge/item_list/?challengeID=${challengeId}&count=30&cursor=0&aid=1988&app_language=en`,
    { 'accept': 'application/json', 'referer': 'https://www.tiktok.com/' }
  );
  if (!feedResp.ok) throw new Error(`TikTok challenge feed HTTP ${feedResp.status}`);
  const feedJson = await feedResp.json();
  const items = feedJson.itemList || [];

  const seen = new Set();
  const profiles = [];
  for (const item of items) {
    const a = item.author || item.authorStats;
    const stats = item.authorStats || {};
    if (!a?.uniqueId || seen.has(a.uniqueId)) continue;
    seen.add(a.uniqueId);
    profiles.push({
      handle:     a.uniqueId,
      fullName:   a.nickname || '',
      followers:  String(stats.followerCount ?? a.fans ?? ''),
      bio:        a.signature || '',
      isVerified: !!(a.verified),
      postCount:  String(stats.videoCount ?? ''),
      profileUrl: `https://www.tiktok.com/@${a.uniqueId}`,
      rawPlatform: 'tiktok',
    });
  }
  return profiles;
}

// ── YouTube channel search ─────────────────────────────────────────────────
// YouTube search page still embeds ytInitialData — parse it directly
async function ytKeywordSearch(keyword) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`;
  const resp = await bdFetch(url, {
    'accept': 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  }, 30000);
  if (!resp.ok) throw new Error(`YouTube HTTP ${resp.status}`);
  const html = await resp.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!m) return { profiles: [], debug: { htmlLength: html.length, htmlSnippet: html.slice(0, 300) } };
  const data = JSON.parse(m[1]);
  const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?.sectionListRenderer?.contents || [];
  const profiles = [];
  for (const section of contents) {
    for (const item of (section?.itemSectionRenderer?.contents || [])) {
      const ch = item?.channelRenderer;
      if (!ch) continue;
      profiles.push({
        handle:     ch.channelId || '',
        fullName:   ch.title?.simpleText || '',
        followers:  (ch.subscriberCountText?.simpleText || '').replace(/\s*subscribers?/i, '').trim(),
        bio:        ch.descriptionSnippet?.runs?.map(r => r.text).join('') || '',
        isVerified: !!(ch.ownerBadges?.some(b => b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED')),
        postCount:  ch.videoCountText?.runs?.map(r => r.text).join('') || '',
        profileUrl: `https://www.youtube.com/channel/${ch.channelId}`,
        rawPlatform: 'youtube',
      });
    }
  }
  return { profiles };
}

// ── X user search via internal GraphQL API ─────────────────────────────────
async function xUserSearch(keyword) {
  const query = encodeURIComponent(keyword);
  const variables = encodeURIComponent(JSON.stringify({
    rawQuery: keyword,
    count: 20,
    querySource: 'typed_query',
    product: 'People',
  }));
  const features = encodeURIComponent(JSON.stringify({
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_media_download_video_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  }));
  const resp = await bdFetch(
    `https://x.com/i/api/graphql/gkjsKepM6gl_HmFWoWKfgg/SearchTimeline?variables=${variables}&features=${features}`,
    {
      'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'content-type': 'application/json',
    }
  );
  if (!resp.ok) throw new Error(`X search HTTP ${resp.status}`);
  const json = await resp.json();
  const instructions = json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  const entries = instructions.flatMap(i => i.entries || []);
  const profiles = [];
  for (const entry of entries) {
    const userResult = entry?.content?.itemContent?.user_results?.result;
    const user = userResult?.legacy;
    if (!user?.screen_name) continue;
    profiles.push({
      handle:     user.screen_name,
      fullName:   user.name || '',
      followers:  String(user.followers_count ?? ''),
      bio:        user.description || '',
      isVerified: !!(userResult?.is_blue_verified || user.verified),
      postCount:  String(user.statuses_count ?? ''),
      location:   user.location || '',
      profileUrl: `https://x.com/${user.screen_name}`,
      rawPlatform: 'x',
    });
  }
  return { profiles };
}

async function handleBdSearch(req, res) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });

  const { platform, keyword } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword is required' });

  const kw = keyword.trim();
  console.log(`[bd-search:${platform}] keyword="${kw}"`);

  let profiles = [];
  let debug = null;
  try {
    if (platform === 'instagram') {
      profiles = await igHashtagSearch(kw);
    } else if (platform === 'tiktok') {
      profiles = await ttHashtagSearch(kw);
    } else if (platform === 'youtube') {
      const result = await ytKeywordSearch(kw);
      profiles = result.profiles;
      if (result.debug) debug = result.debug;
    } else if (platform === 'x') {
      const result = await xUserSearch(kw);
      profiles = result.profiles;
    }
  } catch (e) {
    console.error(`[bd-search:${platform}] error:`, e.message);
    return res.status(502).json({ error: e.message });
  }

  // Deduplicate by handle
  const seen = new Set();
  profiles = profiles.filter(p => {
    if (!p.handle || seen.has(p.handle.toLowerCase())) return false;
    seen.add(p.handle.toLowerCase());
    return true;
  });

  console.log(`[bd-search:${platform}] → ${profiles.length} profiles`);

  if (profiles.length === 0) {
    return res.status(200).json({ profiles: [], debug });
  }

  return res.status(200).json({ profiles });
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
