// POST /api/brightdata-enrich
// Body: { platform: 'instagram'|'tiktok'|'youtube'|'x', profiles: ['@handle', ...] }
//
// Uses BrightData Web Scraper API (snapshot/dataset flow):
//   1. POST to trigger a snapshot with the list of profiles
//   2. Poll GET until status = 'ready'
//   3. Download the snapshot rows and normalise into our standard shape
//
// Required env vars:
//   BRIGHTDATA_API_TOKEN  — your BrightData API token
//   BRIGHTDATA_IG_DATASET_ID   — dataset ID for Instagram profiles
//   BRIGHTDATA_TT_DATASET_ID   — dataset ID for TikTok profiles
//   BRIGHTDATA_YT_DATASET_ID   — dataset ID for YouTube profiles
//   BRIGHTDATA_X_DATASET_ID    — dataset ID for X/Twitter profiles

import { checkAuth } from './_auth.js';

const BD_API = 'https://api.brightdata.com/datasets/v3';

// Map platform → env var name for the dataset ID
const DATASET_ENV = {
  instagram: 'BRIGHTDATA_IG_DATASET_ID',
  tiktok:    'BRIGHTDATA_TT_DATASET_ID',
  youtube:   'BRIGHTDATA_YT_DATASET_ID',
  x:         'BRIGHTDATA_X_DATASET_ID',
};

// BrightData profile URL builders per platform
function profileUrl(platform, handle) {
  const h = handle.replace(/^@/, '');
  if (platform === 'instagram') return `https://www.instagram.com/${h}/`;
  if (platform === 'tiktok')    return `https://www.tiktok.com/@${h}`;
  if (platform === 'youtube')   return `https://www.youtube.com/@${h}`;
  if (platform === 'x')         return `https://x.com/${h}`;
  return null;
}

// Normalise a BrightData row into our standard result shape
function normalise(platform, row) {
  if (!row) return null;
  if (platform === 'instagram') {
    return {
      handle:     row.username || row.handle || '',
      fullName:   row.name     || row.full_name || '',
      followers:  String(row.followers ?? row.follower_count ?? ''),
      bio:        row.biography || row.description || '',
      postCount:  String(row.posts ?? row.post_count ?? row.media_count ?? ''),
      isPrivate:  !!(row.is_private),
      isVerified: !!(row.verified || row.is_verified),
      url:        row.url || '',
    };
  }
  if (platform === 'tiktok') {
    return {
      handle:     row.unique_id || row.username || '',
      fullName:   row.nickname  || row.name || '',
      followers:  String(row.fans ?? row.follower_count ?? row.followers ?? ''),
      bio:        row.signature || row.bio || '',
      postCount:  String(row.video_count ?? row.post_count ?? ''),
      isPrivate:  !!(row.is_private_account),
      isVerified: !!(row.verified),
      url:        row.url || '',
    };
  }
  if (platform === 'youtube') {
    return {
      handle:     row.channel_name || row.username || '',
      fullName:   row.channel_name || row.name || '',
      followers:  String(row.subscribers ?? row.subscriber_count ?? row.followers ?? ''),
      bio:        row.description || '',
      postCount:  String(row.video_count ?? ''),
      isPrivate:  false,
      isVerified: !!(row.verified),
      country:    row.country || '',
      url:        row.url || '',
    };
  }
  if (platform === 'x') {
    return {
      handle:     row.username || row.screen_name || '',
      fullName:   row.name || '',
      followers:  String(row.followers ?? row.followers_count ?? ''),
      bio:        row.description || row.bio || '',
      postCount:  String(row.posts ?? row.statuses_count ?? ''),
      isPrivate:  !!(row.protected),
      isVerified: !!(row.verified || row.is_blue_verified),
      location:   row.location || '',
      url:        row.url || '',
    };
  }
  return null;
}

async function pollSnapshot(snapshotId, token, maxWaitMs = 120000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const resp = await fetch(`${BD_API}/snapshot/${snapshotId}?format=json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 202) continue; // still processing
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Snapshot poll failed: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
    }
    // 200 = ready, body is the NDJSON/JSON result
    return resp;
  }
  throw new Error('BrightData snapshot timed out after 2 minutes');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'BRIGHTDATA_API_TOKEN env var not set' });
  }

  const { platform, profiles } = req.body || {};
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'];
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }
  if (!Array.isArray(profiles) || !profiles.length) {
    return res.status(400).json({ error: 'profiles[] is required' });
  }

  const datasetId = process.env[DATASET_ENV[platform]];
  if (!datasetId) {
    return res.status(500).json({ error: `${DATASET_ENV[platform]} env var not set` });
  }

  // Build the input rows BrightData expects
  const inputs = profiles
    .map(p => ({ url: profileUrl(platform, p) }))
    .filter(r => r.url);

  // 1. Trigger snapshot
  let snapshotId;
  try {
    const triggerResp = await fetch(
      `${BD_API}/trigger?dataset_id=${datasetId}&include_errors=true&format=json&uncompressed_webhook=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(inputs),
      }
    );
    const triggerData = await triggerResp.json();
    if (!triggerResp.ok) {
      return res.status(502).json({ error: triggerData.message || triggerData.error || `BrightData trigger failed: HTTP ${triggerResp.status}` });
    }
    snapshotId = triggerData.snapshot_id;
    if (!snapshotId) {
      return res.status(502).json({ error: 'BrightData did not return a snapshot_id', raw: triggerData });
    }
  } catch (e) {
    return res.status(502).json({ error: `BrightData trigger error: ${e.message}` });
  }

  console.log(`[brightdata:${platform}] snapshot triggered: ${snapshotId}, waiting…`);

  // 2. Poll until ready
  let rawRows;
  try {
    const snapResp = await pollSnapshot(snapshotId, token);
    const text = await snapResp.text();
    // BrightData may return a JSON array or NDJSON
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

  // 3. Normalise and key by the original handle
  const results = {};
  for (let i = 0; i < profiles.length; i++) {
    const handle = profiles[i].replace(/^@/, '');
    const row    = rawRows[i] || rawRows.find(r =>
      (r.username || r.unique_id || r.screen_name || r.channel_name || '')
        .toLowerCase() === handle.toLowerCase()
    );
    if (!row) {
      results[profiles[i]] = { error: 'not_found' };
      continue;
    }
    if (row.error || row.status === 'failed') {
      results[profiles[i]] = { error: row.error || row.message || 'scrape_failed' };
      continue;
    }
    const normalised = normalise(platform, row);
    results[profiles[i]] = normalised || { error: 'normalise_failed' };
  }

  return res.status(200).json({ results, snapshot_id: snapshotId });
}
