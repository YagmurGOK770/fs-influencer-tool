// POST /api/compare-bio
// Body: { oldValue: string, newValue: string, field?: string }
// Returns: { changed: bool, reason: string }
// Uses Claude to decide if the meaning has meaningfully shifted.
// Works for any narrative field: who_they_are, why_follow, target_audience,
// tone_style, what_they_post.

import Anthropic from '@anthropic-ai/sdk';
import { checkAuth, requireApiKey } from './_auth.js';

const FIELD_CONTEXT = {
  who_they_are:    'a one-sentence description of who this influencer is',
  why_follow:      'a one-sentence reason why someone would follow this influencer',
  target_audience: 'a description of this influencer\'s target audience',
  tone_style:      'a description of this influencer\'s tone and content style',
  what_they_post:  'a description of the type of content this influencer posts',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;
  if (!requireApiKey(res)) return;

  const { oldValue, newValue, field } = req.body || {};
  if (!oldValue || !newValue) {
    return res.status(400).json({ error: 'oldValue and newValue are required' });
  }

  const fieldContext = FIELD_CONTEXT[field] || 'a description of this influencer';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let message;
  try {
    message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `These are two versions of ${fieldContext}. Has the meaning or focus meaningfully changed, or is it essentially the same thing described differently?

Before: "${oldValue}"
After: "${newValue}"

Reply with ONLY a valid JSON object, no markdown, no extra text:
{"changed": true, "reason": "one short sentence"} or {"changed": false, "reason": "one short sentence"}

Count as NOT changed: same meaning in different words, minor rephrasing, added detail that doesn't change the core idea.
Count as changed: different focus, different audience, different style described, meaningfully new information.`
      }]
    });
  } catch (apiErr) {
    return res.status(500).json({ error: apiErr.message });
  }

  const text = message.content[0].text.trim();
  const clean = text.replace(/^```[a-z]*\n?/,'').replace(/\n?```$/,'').trim();
  try {
    const json = JSON.parse(clean);
    return res.status(200).json(json);
  } catch {
    return res.status(500).json({ error: 'Bad JSON from model', raw: clean });
  }
}
