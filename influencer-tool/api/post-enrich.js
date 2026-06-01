// Shared post-enrichment fetchers.
//
// Pulls a profile's recent ~30 posts/videos with per-post engagement, normalized to a
// uniform shape, across all platforms:
//   - Instagram / TikTok / X  → Apify actors (pay-per-result)
//   - YouTube                 → official YouTube Data API v3 (free, quota-based)
//
// Used by the /api/verify "bd-scan-posts" endpoint and by scripts/enrich-posts-batch.mjs.
//
// Uniform post shape returned by every fetcher:
//   { postId, url, type, caption, hashtags[], mentions[], likes, comments, views,
//     saves, shares, postedAt(ISO), location, taggedUsers[], music, durationSec,
//     thumbnailUrl, mediaUrls[], raw }
// Any metric a platform can't provide is null.

const APIFY = 'https://api.apify.com/v2';
const YT_API = 'https://www.googleapis.com/youtube/v3';

export const POSTS_PER_PROFILE = 30;

// Short-form video threshold. YouTube Shorts max out at 3 min; the Data API has no isShort
// field, so we derive it from duration. Also flags TikToks / IG reels of similar length.
const SHORT_MAX_SEC = 180;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const stripAt = (h) => String(h || '').trim().replace(/^@/, '');
const lc = (h) => stripAt(h).toLowerCase();

// Run an async mapper over items with a bounded number of workers in flight.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── Apify run helper: start actor, poll to completion, return all dataset items ──
// Retries transient failures with backoff for idempotent GETs (status polls, dataset reads)
// so a flaky network/5xx after an actor already ran+billed doesn't discard the whole result.
// POSTs (actor starts) are NEVER retried — a retry could start a second billed run.
async function apifyJson(url, opts = {}) {
  const isPost = (opts.method || 'GET').toUpperCase() === 'POST';
  const retries = isPost ? 0 : 4;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();
      if (r.status >= 500 || r.status === 429) throw new Error(`Apify HTTP ${r.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`Apify HTTP ${r.status}: ${text.slice(0, 200)}`); }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export async function runApifyActor(actorSlug, input, { onProgress, maxWaitMs = 600000 } = {}) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not configured');
  const slug = actorSlug.replace('/', '~');

  const run = await apifyJson(`${APIFY}/acts/${slug}/runs?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const runId = run?.data?.id;
  const datasetId = run?.data?.defaultDatasetId;
  if (!runId) throw new Error(`Apify start failed: ${JSON.stringify(run).slice(0, 200)}`);

  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const s = await apifyJson(`${APIFY}/actor-runs/${runId}?token=${token}`);
    const status = s?.data?.status;
    onProgress?.({ itemCount: s?.data?.stats?.itemCount ?? 0, status });
    if (status === 'SUCCEEDED') break;
    if (TERMINAL.has(status)) throw new Error(`Apify run ${status}: ${JSON.stringify(s?.data?.statusMessage ?? '')}`);
  }

  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await apifyJson(`${APIFY}/datasets/${datasetId}/items?token=${token}&clean=true&offset=${offset}&limit=1000`);
    if (!Array.isArray(batch) || !batch.length) break;
    items.push(...batch);
    if (batch.length < 1000) break;
  }
  return items;
}

// ── Instagram (apify/instagram-scraper) ─────────────────────────────────────
async function fetchInstagram(profiles, onProgress) {
  const usernames = profiles.map(p => lc(p.handle)).filter(Boolean);
  if (!usernames.length) return new Map();
  const items = await runApifyActor('apify/instagram-scraper', {
    directUrls: usernames.map(u => `https://www.instagram.com/${u}/`),
    resultsType: 'posts',
    resultsLimit: POSTS_PER_PROFILE,
    addParentData: false,
  }, { onProgress });

  const byHandle = new Map();
  for (const it of items) {
    const owner = lc(it.ownerUsername || '');
    if (!owner) continue;
    if (!byHandle.has(owner)) byHandle.set(owner, []);
    const type = ({ image: 'image', video: 'video', sidecar: 'carousel' })[String(it.type || '').toLowerCase()] || (it.type || '').toLowerCase() || null;
    byHandle.get(owner).push({
      postId: it.shortCode || it.id || null,
      url: it.url || (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : null),
      type,
      caption: it.caption || null,
      hashtags: it.hashtags || null,
      mentions: it.mentions || null,
      likes: num(it.likesCount),                       // -1 (hidden) → null via num()
      comments: num(it.commentsCount),
      views: num(it.videoViewCount ?? it.videoPlayCount),
      saves: null,                                      // not available on Instagram
      shares: null,                                     // not available on Instagram
      postedAt: it.timestamp || null,
      location: it.locationName || null,
      taggedUsers: Array.isArray(it.taggedUsers) ? it.taggedUsers.map(u => u.username).filter(Boolean) : null,
      music: null,
      durationSec: it.videoDuration != null ? Math.round(it.videoDuration) : null,
      thumbnailUrl: it.displayUrl || null,
      mediaUrls: (it.images && it.images.length) ? it.images : (it.videoUrl ? [it.videoUrl] : (it.displayUrl ? [it.displayUrl] : null)),
      raw: it,
    });
  }
  return byHandle;
}

// ── TikTok (clockworks/tiktok-scraper) ──────────────────────────────────────
async function fetchTikTok(profiles, onProgress) {
  const usernames = profiles.map(p => lc(p.handle)).filter(Boolean);
  if (!usernames.length) return new Map();
  const items = await runApifyActor('clockworks/tiktok-scraper', {
    profiles: usernames,
    resultsPerPage: POSTS_PER_PROFILE,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  }, { onProgress });

  const byHandle = new Map();
  for (const it of items) {
    const owner = lc(it.authorMeta?.name || it.author?.uniqueId || '');
    if (!owner) continue;
    if (!byHandle.has(owner)) byHandle.set(owner, []);
    byHandle.get(owner).push({
      postId: it.id || null,
      url: it.webVideoUrl || null,
      type: it.isSlideshow ? 'slideshow' : 'video',
      caption: it.text || it.desc || null,
      hashtags: Array.isArray(it.hashtags) ? it.hashtags.map(h => h.name || h).filter(Boolean) : null,
      mentions: it.mentions || null,
      likes: num(it.diggCount ?? it.stats?.diggCount),
      comments: num(it.commentCount ?? it.stats?.commentCount),
      views: num(it.playCount ?? it.stats?.playCount),
      saves: num(it.collectCount ?? it.stats?.collectCount),
      shares: num(it.shareCount ?? it.stats?.shareCount),
      postedAt: it.createTimeISO || null,
      location: typeof it.locationCreated === 'string'
        ? (it.locationCreated || null)
        : (it.locationCreated?.city || it.locationCreated?.country || null),
      taggedUsers: null,
      music: it.musicMeta?.musicName || null,
      durationSec: it.videoMeta?.duration != null ? Math.round(it.videoMeta.duration) : null,
      thumbnailUrl: it.videoMeta?.coverUrl || it.coverUrl || null,
      mediaUrls: it.mediaUrls || null,
      raw: it,
    });
  }
  return byHandle;
}

// ── X / Twitter (kaitoeasyapi, one run per profile) ─────────────────────────
function parseTwitterDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchXOne(handle) {
  const user = stripAt(handle);
  const items = await runApifyActor(
    'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    { from: user, maxItems: POSTS_PER_PROFILE, queryType: 'Latest' },
  );
  // A `from:<user>` timeline can include native retweets (authored by someone else) — drop them
  // so we don't attribute other accounts' posts/metrics to this influencer. Also dedupe by tweet id:
  // the actor sometimes returns the same tweet twice (pinned/pagination overlap), which would both
  // skew the median and break the upsert (can't touch the same conflict key twice in one batch).
  const seenIds = new Set();
  const mine = items.filter(it => {
    const isRetweet = !!it.retweeted_tweet || /^RT @/.test(it.text || '');
    const authorOk = !it.author?.userName || lc(it.author.userName) === lc(user);
    if (isRetweet || !authorOk) return false;
    if (it.id != null) { if (seenIds.has(it.id)) return false; seenIds.add(it.id); }
    return true;
  });
  // kaito ignores maxItems and returns a full page (~40); enforce the "recent N" contract
  // (queryType 'Latest' is newest-first) to keep cost/consistency in line with other platforms.
  return mine.slice(0, POSTS_PER_PROFILE).map(it => ({
    postId: it.id || null,
    url: it.url || it.twitterUrl || null,
    type: 'tweet',
    caption: it.text || null,
    hashtags: Array.isArray(it.entities?.hashtags) ? it.entities.hashtags.map(h => h.text).filter(Boolean) : null,
    mentions: Array.isArray(it.entities?.user_mentions) ? it.entities.user_mentions.map(m => m.screen_name).filter(Boolean) : null,
    likes: num(it.likeCount),
    comments: num(it.replyCount),
    views: num(it.viewCount),
    saves: num(it.bookmarkCount),
    shares: num((it.retweetCount || 0) + (it.quoteCount || 0)),
    postedAt: parseTwitterDate(it.createdAt),
    location: it.place?.full_name || null,
    taggedUsers: null,
    music: null,
    durationSec: null,
    thumbnailUrl: null,
    mediaUrls: Array.isArray(it.extendedEntities?.media) ? it.extendedEntities.media.map(m => m.media_url_https).filter(Boolean) : null,
    raw: it,
  }));
}

// Terminal account/quota limits — once hit, every further call fails, so stop trying. Crucially,
// callers must NOT treat these (or any fetch error) as "0 posts / done": leave the handle ABSENT
// from the result map so the batch logs it as retryable, not as a completed 0-post profile.
export function isHardLimit(e) {
  const m = (e && e.message) || String(e || '');
  return /monthly usage hard limit|platform-feature-disabled|quota ?exceeded|usage hard limit/i.test(m);
}

async function fetchX(profiles, onProgress, concurrency = 6) {
  const byHandle = new Map();
  let done = 0, stop = false;
  await mapPool(profiles, concurrency, async (p) => {
    if (stop) return;  // limit already hit — skip remaining (left absent → retried next run)
    try { byHandle.set(lc(p.handle), await fetchXOne(p.handle)); }  // [] = genuinely no tweets (done)
    catch (e) {
      if (isHardLimit(e)) { stop = true; console.warn(`[x-scan] aborting — ${e.message}`); }
      else console.warn(`[x-scan] ${p.handle}: ${e.message}`);
      // do NOT set byHandle → caller retries this handle
    }
    onProgress?.({ itemCount: ++done });
  });
  if (stop) console.warn('[x-scan] stopped early on usage limit; unfetched X profiles will retry next run');
  return byHandle;
}

// ── YouTube (official Data API v3) ──────────────────────────────────────────
function iso8601ToSec(d) {
  if (!d) return null;
  const m = String(d).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m || m.slice(1).every(g => g == null)) return null; // no components (e.g. "P0D" live)
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// YouTube Data API quota is PER GCP PROJECT (10k units/day). To get more throughput in one day,
// supply keys from separate projects via YOUTUBE_API_KEY, YOUTUBE_API_KEY_2/_3/…, or a
// comma-separated YOUTUBE_API_KEYS. We rotate to the next key when one reports quotaExceeded.
let _ytKeys = null, _ytIdx = 0;
function ytKeyPool() {
  if (_ytKeys) return _ytKeys;
  const list = [];
  for (const k of ['YOUTUBE_API_KEY', 'YOUTUBE_API_KEY_2', 'YOUTUBE_API_KEY_3', 'YOUTUBE_API_KEY_4', 'YOUTUBE_API_KEY_5']) {
    if (process.env[k]) list.push(process.env[k].trim());
  }
  if (process.env.YOUTUBE_API_KEYS) list.push(...process.env.YOUTUBE_API_KEYS.split(',').map(s => s.trim()).filter(Boolean));
  _ytKeys = [...new Set(list.filter(Boolean))];
  return _ytKeys;
}

// GET a YouTube Data API path (without key). Rotates across the key pool on quotaExceeded; throws
// quotaExceeded only when ALL keys are exhausted (so the caller leaves the handle to retry).
async function ytFetch(pathAndQuery) {
  const keys = ytKeyPool();
  if (!keys.length) throw new Error('YOUTUBE_API_KEY not configured');
  for (let tries = 0; tries < keys.length; tries++) {
    const j = await (await fetch(`${YT_API}/${pathAndQuery}&key=${keys[_ytIdx % keys.length]}`)).json();
    if (!j.error) return j;
    const reason = j.error?.errors?.[0]?.reason || j.error.message || '';
    if (/quota/i.test(reason) && keys.length > 1) { _ytIdx++; continue; } // exhausted this key — try next
    throw new Error(`YouTube API: ${reason}`);
  }
  throw new Error('YouTube API: quotaExceeded'); // every key is out of quota
}

// Resolve a YouTube channel to its uploads playlist using profileUrl (preferred) or handle.
async function resolveYouTubeUploads(handle, profileUrl) {
  let qs = null;
  const url = String(profileUrl || '');
  const chanMatch = url.match(/\/channel\/(UC[\w-]+)/);
  if (chanMatch) qs = `id=${chanMatch[1]}`;
  else {
    const atMatch = url.match(/\/@([^/?#]+)/);
    const h = atMatch ? atMatch[1] : stripAt(handle);
    if (h) qs = `forHandle=${encodeURIComponent(h)}`;
  }
  if (!qs) return null;
  const ch = await ytFetch(`channels?part=contentDetails&${qs}`);
  return ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}

async function fetchYouTubeOne(handle, profileUrl) {
  if (!ytKeyPool().length) throw new Error('YOUTUBE_API_KEY not configured');
  const uploads = await resolveYouTubeUploads(handle, profileUrl);
  if (!uploads) return [];
  const pl = await ytFetch(`playlistItems?part=contentDetails&maxResults=${POSTS_PER_PROFILE}&playlistId=${uploads}`);
  const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await ytFetch(`videos?part=statistics,contentDetails,snippet&id=${ids.join(',')}`);
  return (vids.items || []).map(v => ({
    postId: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    type: 'video',
    caption: v.snippet?.title || null,
    hashtags: Array.isArray(v.snippet?.tags) ? v.snippet.tags : null,
    mentions: null,
    likes: num(v.statistics?.likeCount),
    comments: num(v.statistics?.commentCount),
    views: num(v.statistics?.viewCount),
    saves: null,
    shares: null,
    postedAt: v.snippet?.publishedAt || null,
    location: null,
    taggedUsers: null,
    music: null,
    durationSec: iso8601ToSec(v.contentDetails?.duration),
    thumbnailUrl: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
    mediaUrls: null,
    raw: v,
  }));
}

async function fetchYouTube(profiles, onProgress, concurrency = 8) {
  const byHandle = new Map();
  let done = 0, stop = false;
  await mapPool(profiles, concurrency, async (p) => {
    if (stop) return;  // quota already hit — skip remaining (left absent → retried next run)
    try { byHandle.set(lc(p.handle), await fetchYouTubeOne(p.handle, p.profileUrl)); }  // [] = no uploads (done)
    catch (e) {
      if (isHardLimit(e)) { stop = true; console.warn(`[yt-scan] aborting — ${e.message}`); }
      else console.warn(`[yt-scan] ${p.handle}: ${e.message}`);
      // do NOT set byHandle → caller retries this handle
    }
    onProgress?.({ itemCount: ++done });
  });
  if (stop) console.warn('[yt-scan] stopped early on quota; unfetched YouTube profiles will retry next run (quota resets daily)');
  return byHandle;
}

// ── Unified entry point ─────────────────────────────────────────────────────
// platform: 'instagram' | 'tiktok' | 'x' | 'youtube'
// profiles: [{ handle, profileUrl }]
// returns Map<handleLower, post[]>
export async function fetchPostsForPlatform(platform, profiles, { onProgress, concurrency } = {}) {
  switch (platform) {
    case 'instagram': return fetchInstagram(profiles, onProgress);
    case 'tiktok':    return fetchTikTok(profiles, onProgress);
    case 'x':         return fetchX(profiles, onProgress, concurrency ?? 6);
    case 'youtube':   return fetchYouTube(profiles, onProgress, concurrency ?? 8);
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────
export function postToRow(handle, platform, post) {
  return {
    handle: lc(handle),
    platform,
    post_id: post.postId != null ? String(post.postId) : null,
    post_url: post.url,
    type: post.type,
    caption: post.caption,
    hashtags: post.hashtags,
    mentions: post.mentions,
    likes: post.likes,
    comments: post.comments,
    views: post.views,
    saves: post.saves,
    shares: post.shares,
    posted_at: post.postedAt,
    location: post.location,
    tagged_users: post.taggedUsers,
    music: post.music,
    duration_sec: post.durationSec,
    is_short: post.durationSec != null && post.durationSec <= SHORT_MAX_SEC,
    thumbnail_url: post.thumbnailUrl,
    media_urls: post.mediaUrls,
    raw: post.raw,
    fetched_at: new Date().toISOString(),
  };
}

// Profile-level aggregates from a post array. engagement_rate needs followers (caller supplies).
export function computeAggregates(allPosts, followers) {
  // Score the latest ~30 posts (by date). Some actors return more than we ask for; capping here
  // keeps "recent 30" consistent whether called at enrichment or on a later free recompute.
  const posts = [...allPosts]
    .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0))
    .slice(0, POSTS_PER_PROFILE);
  const avg = (key) => {
    const vals = posts.map(p => p[key]).filter(v => v != null && v >= 0);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  // Median over the latest posts (could be < 30). Robust to one viral/dead post — used as the
  // primary engagement-score input. Null metrics are excluded (not zero-filled).
  const median = (key) => {
    const vals = posts.map(p => p[key]).filter(v => v != null && v >= 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    const mid = vals.length >> 1;
    return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  };
  const posts_sampled = posts.length;
  const avg_likes = avg('likes');
  const avg_comments = avg('comments');
  const f = Number(followers) || 0;
  const engagement_rate = (f > 0 && (avg_likes != null || avg_comments != null))
    ? Number((((avg_likes || 0) + (avg_comments || 0)) / f * 100).toFixed(2))
    : null;
  // ── Recency / velocity inputs (latest 5 posts, engagement-per-day) ──────────
  // For each recent post, divide its engagement by how many days it had been live when we
  // measured it (now ≈ fetched_at), so fast-accruing fresh posts weigh more. Average per metric.
  // e.g. 1,000 likes on a 2-day-old post → 500 likes/day. Null metrics are excluded (not zeroed),
  // mirroring avg() above, so a platform that lacks saves/shares isn't penalised.
  const nowMs = Date.now();
  const dated = posts
    .filter(p => p.postedAt)
    .map(p => {
      // Age is measured against when we CAPTURED the counts (per-post fetchedAt), not "now", so a
      // later free recompute from stored posts yields the same velocity instead of drifting.
      const ref = p.fetchedAt && Number.isFinite(Date.parse(p.fetchedAt)) ? Date.parse(p.fetchedAt) : nowMs;
      return { ...p, _ts: Date.parse(p.postedAt), _ref: ref };
    })
    .filter(p => Number.isFinite(p._ts))
    .sort((a, b) => b._ts - a._ts);
  const recent5 = dated.slice(0, 5);
  const dailyAvg = (key) => {
    const rates = recent5
      .filter(p => p[key] != null && p[key] >= 0)
      // Floor age at 2 days: engagement is front-loaded, so a just-posted item must not divide by
      // a tiny age and masquerade as runaway momentum.
      .map(p => p[key] / Math.max(2, (p._ref - p._ts) / 86400000));
    return rates.length ? Number((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)) : null;
  };
  const last_post_at = dated.length ? new Date(dated[0]._ts).toISOString() : null;

  return {
    avg_likes,
    avg_comments,
    avg_views: avg('views'),
    avg_saves: avg('saves'),
    avg_shares: avg('shares'),
    engagement_rate,
    posts_sampled,
    median_likes:    median('likes'),
    median_comments: median('comments'),
    median_views:    median('views'),
    median_saves:    median('saves'),
    median_shares:   median('shares'),
    recent_daily_likes:    dailyAvg('likes'),
    recent_daily_comments: dailyAvg('comments'),
    recent_daily_views:    dailyAvg('views'),
    recent_daily_saves:    dailyAvg('saves'),
    recent_daily_shares:   dailyAvg('shares'),
    last_post_at,
  };
}
