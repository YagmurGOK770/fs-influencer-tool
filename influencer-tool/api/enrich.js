// POST /api/enrich
// Body: { name, handle, platform, followers }
// Returns: { whoTheyAre, whatTheyPost, toneStyle, targetAudience, whyFollow, contentLabels }

import { checkAuth, requireApiKey } from './_auth.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1200;
const MAX_WEB_SEARCHES = 4;

function buildPrompt({ name, handle, platform, followers }) {
  return `You are a UK food influencer research expert. Use the web_search tool to look up this influencer and find real, accurate information about them.

Influencer: ${name || '(unknown)'}
Handle: ${handle || '(unknown)'}
Platform(s): ${platform || 'Instagram'}
Total Followers: ${followers || '(unknown)'}

Search for their social media profile, recent posts, and any press coverage. Use what you find to fill in the profile accurately.

After researching, return ONLY a JSON object with exactly these 6 fields (no extra text, no markdown):
{
  "whoTheyAre": "One sentence describing who this person is (role, background, what makes them notable). Max 15 words.",
  "whatTheyPost": "What type of content they post based on what you found. Max 12 words.",
  "toneStyle": "Their content tone and style. Max 10 words.",
  "targetAudience": "Who follows them. Max 12 words.",
  "whyFollow": "The main reason to follow them. Max 12 words.",
  "contentLabels": "3-5 descriptive labels separated by  ·  (e.g. London Food  ·  Restaurant Reviews  ·  Budget Eats)"
}

Base your answers on what you actually find online. If you cannot find specific information, make a reasonable inference from what is available — but never invent specific facts (awards, employers, books) you cannot verify.`;
}

function extractJsonObject(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) { /* fall through */ }
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

  const { name, handle, platform, followers } = req.body || {};

  if (!handle && !name) {
    return res.status(400).json({ error: 'Either handle or name is required' });
  }

  const prompt = buildPrompt({ name, handle, platform, followers });

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
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('');

    const parsed = extractJsonObject(text);
    if (!parsed) {
      return res.status(502).json({
        error: 'Could not parse JSON from model response',
        rawText: text.slice(0, 500)
      });
    }

    return res.status(200).json({
      whoTheyAre: parsed.whoTheyAre || '',
      whatTheyPost: parsed.whatTheyPost || '',
      toneStyle: parsed.toneStyle || '',
      targetAudience: parsed.targetAudience || '',
      whyFollow: parsed.whyFollow || '',
      contentLabels: parsed.contentLabels || '',
      usage: data.usage
    });
  } catch (err) {
    console.error('Enrich handler error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err.message || err) });
  }
}
