// POST /api/search
// Body: { keywords, location, platform, sources, minFollowers, provider }
// provider: 'anthropic' | 'openai' | 'gemini' | 'grok'  (default: 'anthropic')
// Returns: { influencers: [...], rawText: string, usage: {...}, provider: string }

import { checkAuth, requireApiKey } from './_auth.js';

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

  const isYouTube = String(platform).toLowerCase().includes('youtube');

  const youtubeBlock = isYouTube ? `

YOUTUBE SEARCH STRATEGY — follow this to find channel creators:
- Search: site:youtube.com "${kwList}" ${location} — look for channel URLs like youtube.com/@handle or youtube.com/channel/
- Search: youtube "${kwList}" "${location}" food channel subscribers — find ranked lists and articles about top channels
- Search: best ${location} food YouTube channels ${kwList} — food/restaurant-focused blogs that rank channels
- Search: youtube.com/@* ${location} food — find individual channel pages
- For each channel found, note their subscriber count from search snippets or the channel page
- The "handle" field should be their YouTube @handle (e.g. @londoneatswith)
- Prefer channels with regular uploads and genuine ${location} focus over one-off video makers` : '';

  return `You are a food-influencer research assistant. Search the web to find real food influencers active on social media.

Search keywords: ${kwList}
Location focus: ${location}
Platform focus: ${platform}
Minimum followers/subscribers: ${minFollowers.toLocaleString()}${sourcesBlock}${youtubeBlock}

INCLUSION RULES — be strict:
- The influencer must be clearly based in ${location} OR predominantly post about ${location} food, restaurants, or dining
- Their bio, handle, or content must show genuine ${location} focus (not just one visit)
- They must have a real, verifiable social media presence
- Skip anyone whose follower/subscriber count is below ${minFollowers.toLocaleString()}
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

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function callAnthropic(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
  return { text, usage: data.usage };
}

// ── OpenAI GPT-5.5 ───────────────────────────────────────────────────────────
async function callOpenAI(prompt) {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      tools: [{ type: 'web_search' }],
      input: prompt,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.output || [])
    .filter(b => b.type === 'message')
    .flatMap(b => b.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text || '')
    .join('\n');
  return { text, usage: data.usage };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter(p => p.text)
    .map(p => p.text)
    .join('\n');
  return { text, usage: data.usageMetadata };
}

// ── xAI Grok ──────────────────────────────────────────────────────────────────
// Uses the xAI Responses API (mirrors OpenAI Responses API shape)
async function callGrok(prompt) {
  const resp = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-4.3',
      input: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search' }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Grok error ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  // Responses API output format mirrors OpenAI
  const text = (data.output || [])
    .filter(b => b.type === 'message')
    .flatMap(b => b.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text || '')
    .join('\n');
  return { text, usage: data.usage };
}

const PROVIDERS = {
  anthropic: callAnthropic,
  openai:    callOpenAI,
  gemini:    callGemini,
  grok:      callGrok,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;

  const { keywords, location, platform, sources, minFollowers, provider = 'anthropic' } = req.body || {};

  if (!PROVIDERS[provider]) {
    return res.status(400).json({ error: `Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDERS).join(', ')}` });
  }

  if (!requireApiKey(res, provider)) return;

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
    minFollowers: Number(minFollowers) || 10000,
  });

  try {
    const { text: fullText, usage } = await PROVIDERS[provider](prompt);

    const influencers = extractJsonArray(fullText);

    if (!influencers) {
      return res.status(200).json({
        influencers: [],
        rawText: fullText,
        warning: 'Could not parse JSON array from response',
        usage,
        provider,
      });
    }

    return res.status(200).json({ influencers, rawText: fullText, usage, provider });
  } catch (err) {
    console.error(`[search:${provider}] error:`, err.message);
    return res.status(500).json({ error: err.message, provider });
  }
}
