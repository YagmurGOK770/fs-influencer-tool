// POST /api/compare-bio
// Body: { oldValue: string, newValue: string }
// Returns: { changed: bool, reason: string }
// Uses Claude to decide if the core identity/focus has meaningfully shifted.

import Anthropic from '@anthropic-ai/sdk';
import { checkAuth, requireApiKey } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;
  if (!requireApiKey(res)) return;

  const { oldValue, newValue } = req.body || {};
  if (!oldValue || !newValue) {
    return res.status(400).json({ error: 'oldValue and newValue are required' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let message;
  try {
    message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Compare these two descriptions of the same influencer. Decide if their core identity or professional focus has meaningfully changed, or if it is essentially the same person described differently.

Before: "${oldValue}"
After: "${newValue}"

Reply with ONLY a valid JSON object, no markdown, no extra text:
{"changed": true, "reason": "one short sentence"} or {"changed": false, "reason": "one short sentence"}

Examples of NOT changed: added a new project but same niche, slightly different wording, same career area.
Examples of changed: shifted from food to fitness, went from chef to fashion influencer, completely different focus.`
      }]
    });
  } catch (apiErr) {
    return res.status(500).json({ error: apiErr.message });
  }

  const text = message.content[0].text.trim();
  // Strip markdown code fences if present
  const clean = text.replace(/^```[a-z]*\n?/,'').replace(/\n?```$/,'').trim();
  try {
    const json = JSON.parse(clean);
    return res.status(200).json(json);
  } catch {
    return res.status(500).json({ error: 'Bad JSON from model', raw: clean });
  }
}
