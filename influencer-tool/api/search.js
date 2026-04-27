// POST /api/search
// Body: { keywords: string[], location: string, platform: string, sources: [{name,url,desc}], minFollowers: number }
// Returns: { influencers: [...], rawText: string, usage: {...} }

import { checkAuth, requireApiKey } from './_auth.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_WEB_SEARCHES = 8;

function buildPrompt({ keywords, location, platform, sources, minFollowers }) {
  const kwList = (keywords || []).join(', ');
  const customSources = (sources || []).filter(s => s && s.url);
  const platformSources = (sources || []).filter(s => s && !s.url).map(s => s.name);

  let sourcesBlock = '';
  if (platformSources.length) {
    sourcesBlock += `\nPlatforms to search: ${platformSources.join(', ')}.`;
  }
  if (customSources.length) {
    sourcesBlock += `\n\nAlso check these specific directories — search them and pull any ${location} food creators listed:\n`;
    sourcesBlock += customSources
      .map(s => `- ${s.name} — ${s.url}${s.desc ? ' (' + s.desc + ')' : ''}`)
      .join('\n');
  }

  return `You are a food-influencer research assistant. Use the web_search tool to find real food influencers active on social media.

Search keywords: ${kwList}
Location focus: ${location}
Platform focus: ${platform}
Minimum followers: ${minFollowers.toLocaleString()}${sourcesBlock}

INCLUSION RULES — be strict:
- The influencer must be clearly based in ${location} OR predominantly post about ${location} food, restaurants, or dining
- Their bio, handle, or content must show genuine ${location} focus (not just one visit)
- They must have a real, verifiable social media presence
- Skip anyone whose follower count is below ${minFollowers.toLocaleString()}
- Skip generic lifestyle/travel accounts that don't focus on food

OUTPUT FORMAT — this is critical:
After your research, return ONLY a JSON code block containing an array of influencers. No prose before or after the JSON block. Each object must have exactly these fields:

\`\`\`json
[
  {
    "handle": "@username",
    "name": "Real Name or Brand",
    "platform": "Instagram" | "TikTok" | "YouTube" | "X" | "Instagram | TikTok" (combined),
    "followers": "45K" | "1.2M" | "780",
    "niche": "Food, Restaurant Reviews",
    "location": "London, UK",
    "source": "where you found them",
    "foundVia": "the keyword or directory that surfaced them"
  }
]
\`\`\`

Aim for 8-15 high-quality results. Quality beats quantity — only include accounts you have evidence for.`;
}

function extractJsonArray(text) {
  if (!text) return null;

  // Strategy 1: fenced ```json ... ``` block
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* fall through */ }
  }

  // Strategy 2: first [ to last ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (e) { /* fall through */ }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;
  if (!requireApiKey(res)) return;

  const { keywords, location, platform, sources, minFollowers } = req.body || {};

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'keywords array is required' });
  }
  if (!location || typeof location !== 'string') {
    return res.status(400).json({ error: 'location is required' });
  }

  const prompt = buildPrompt({
    keywords,
    location,
    platform: platform || 'All platforms',
    sources: sources || [],
    minFollowers: Number(minFollowers) || 10000
  });

  try {
    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: MAX_WEB_SEARCHES
          }
        ]
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Anthropic API error:', apiResp.status, errText);
      return res.status(apiResp.status).json({
        error: 'Anthropic API error',
        status: apiResp.status,
        detail: errText.slice(0, 500)
      });
    }

    const data = await apiResp.json();

    // Concatenate all text blocks from the response
    const fullText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');

    const influencers = extractJsonArray(fullText);

    if (!influencers) {
      return res.status(200).json({
        influencers: [],
        rawText: fullText,
        warning: 'Could not parse JSON array from response',
        usage: data.usage
      });
    }

    return res.status(200).json({
      influencers,
      rawText: fullText,
      usage: data.usage
    });
  } catch (err) {
    console.error('Search handler error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err.message || err) });
  }
}
