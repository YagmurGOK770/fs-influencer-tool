// POST /api/classify
// Body: { profiles: [...], provider: 'anthropic'|'openai'|'gemini'|'grok', model: string }
// Returns: { results: [{ handle, platform, type, tier, tier_reason }] }
//
// Tier logic (computed server-side from LLM signals + numeric data):
//   Tier 1 — 100k+ followers, food_focus=true, uk_based=true, ER 2%+, active_recently=true, 2+ platforms
//   Tier 2 — 25k–100k followers, food_focus=true, ER 3%+
//   Tier 3 — 10k–25k followers (micro-influencers, hyper-local)
//   Tier 4 — food_focus=false (non-food, posts about food occasionally)

import Anthropic from '@anthropic-ai/sdk';
import { checkAuth, requireApiKey } from './_auth.js';

const SYSTEM_PROMPT = `You are an expert analyst of social media influencer profiles. Always respond with valid JSON only.`;

const USER_PROMPT = (p) => `Analyse this social media influencer profile and return a JSON assessment.

<creator_types>
Chef — Professional chef with real credentials. Works at or owns a restaurant. Has formal training or title (head chef, sous chef, pastry chef, private chef).
Home Cook & Recipe Creator — Makes food at home. Posts recipes, tutorials, "cook with me" content. About MAKING food, not finding restaurants.
Food Reviewer — Visits one food spot per post and gives opinions. "I tried...", "honest review", ratings, "/10". The default type for food-focused influencers.
Food Guide & Curator — Covers MULTIPLE places per post. Makes lists and compilations. "Top 5 brunch spots", "best eats under £5", "save this list". Curation is the value.
Mukbanger / Eating Show — Entertainment-first eating. Mukbang, ASMR food, eating challenges, speed eating, large portions.
Street Food & Market Explorer — Focused on markets, stalls, food trucks, food halls. Not sit-down restaurants.
Cuisine Specialist — Deep focus on ONE specific cuisine (e.g. only Italian, only coffee, only Japanese).
Drinks & Nightlife Creator — PRIMARY content is cocktails, wine, craft beer, bars, pubs. Food is secondary or absent.
Travel Blogger — Travel is their main thing. Food appears because they visit cities, not because food is their focus.
Lifestyle Blogger — Fashion, beauty, fitness, wellness, parenting, or general life. Food is a small part at most.
City Guide / Editorial — NOT a person. A brand, magazine, or tourism account (e.g. Visit London, Time Out). No personal pronouns in bio.
</creator_types>

<rules>
- Pick the ONE type that best describes what this person primarily does
- Look at bio first, then handle/name, then post captions
- Default to "Food Reviewer" if food-focused but type is unclear
- "City Guide / Editorial" is only for brand/org accounts, not individual curators
- If bio says "travel and food" check posts — if most posts are about food, pick a food type
- If bio mentions "chef" casually but no restaurant, use "Home Cook & Recipe Creator"
- food_focus=true means food is their PRIMARY content (50%+ of posts). Travel bloggers who visit restaurants are food_focus=false.

UK DETECTION — be strict and conservative:
- uk_based=true ONLY when there is explicit, unambiguous evidence the creator lives or primarily operates in the UK. Acceptable signals:
    * location field names a UK place (London, Manchester, Birmingham, Edinburgh, Glasgow, UK, England, Scotland, Wales, Northern Ireland, GB, Britain, British, 🇬🇧, 🏴󠁧󠁢󠁥󠁮󠁧󠁿, etc.)
    * bio explicitly says "based in {UK place}", "London-based", "UK chef", etc.
    * posts repeatedly reference UK venues by name (multiple London restaurants, "in Manchester today", etc.)
- uk_based=false ONLY when location or bio clearly indicates ANOTHER country (United States, Canada, Australia, Dubai, Singapore, NYC, LA, Paris, Berlin, Toronto, Sydney, etc.) OR posts are exclusively non-UK venues.
- uk_based=null when there is no clear signal either way — DO NOT guess. An English-language food bio without geographic markers is NOT enough.
- A single passing mention of a UK city in a caption is NOT enough to override an explicit non-UK location.

- active_recently=true if post captions feel current (recent slang, recent venues, active posting cadence implied)
</rules>

<profile>
handle: ${p.handle}
full_name: ${p.full_name || ''}
platform: ${p.platform}
followers: ${p.followers || ''}
location: ${p.location || '(none stored)'}
bio: ${p.bio || '(no bio)'}
recent_posts: ${p.post_captions?.length ? p.post_captions.slice(0, 8).join(' | ') : '(no posts)'}
</profile>

Respond ONLY with this JSON, nothing else:
{"type": "", "food_focus": true, "uk_based": true, "active_recently": true, "reason": ""}
- uk_based MUST be one of: true, false, or null (use null when unknown, not true)
- food_focus MUST be one of: true, false, or null`;

// Compute tier from LLM signals + numeric profile data
function computeTier(llm, profile) {
  const followers = Number(profile.followers) || 0;
  const er = Number(profile.engagement_rate) || 0;
  const platforms = profile.platform_count || 1;

  if (!llm.food_focus) {
    return { tier: 4, tier_reason: 'Non-food creator — posts about food occasionally' };
  }
  if (followers >= 100000 && llm.uk_based && er >= 2 && llm.active_recently && platforms >= 2) {
    return { tier: 1, tier_reason: 'Priority outreach: 100k+ followers, UK-based, 2%+ ER, active, multi-platform' };
  }
  if (followers >= 100000 && llm.uk_based && er >= 2 && llm.active_recently) {
    return { tier: 1, tier_reason: 'Priority outreach: 100k+ followers, UK-based, 2%+ ER, active' };
  }
  if (followers >= 25000 && er >= 3) {
    return { tier: 2, tier_reason: 'Strong candidate: 25k–100k followers, 3%+ ER' };
  }
  if (followers >= 25000) {
    return { tier: 2, tier_reason: 'Strong candidate: 25k–100k followers, good reach' };
  }
  if (followers >= 10000) {
    return { tier: 3, tier_reason: 'Watch list: micro-influencer 10k–25k, potential hyper-local authority' };
  }
  // Under 10k but food-focused — still tier 3
  return { tier: 3, tier_reason: 'Watch list: under 10k followers, food-focused micro account' };
}

function parseResult(text) {
  const clean = text.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

async function classifyWithClaude(client, model, profile) {
  const msg = await client.messages.create({
    model,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: USER_PROMPT(profile) }],
  });
  return parseResult(msg.content[0].text);
}

async function classifyWithOpenAI(model, profile) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set in .env.local');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: USER_PROMPT(profile) },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `OpenAI HTTP ${resp.status}`);
  return parseResult(data.choices[0].message.content);
}

async function classifyWithGemini(model, profile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env.local');
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM_PROMPT + '\n\n' + USER_PROMPT(profile) }] }],
      generationConfig: { maxOutputTokens: 300 },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
  return parseResult(data.candidates[0].content.parts[0].text);
}

async function classifyWithGrok(model, profile) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not set in .env.local');
  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 250,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: USER_PROMPT(profile) },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `xAI HTTP ${resp.status}`);
  return parseResult(data.choices[0].message.content);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req, res)) return;
  if (!requireApiKey(res)) return;

  const { profiles, provider = 'anthropic', model = 'claude-haiku-4-5-20251001' } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length) {
    return res.status(400).json({ error: 'profiles array required' });
  }
  if (profiles.length > 100) {
    return res.status(400).json({ error: 'Max 100 profiles per request' });
  }

  const anthropicClient = provider === 'anthropic'
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

  async function classifyOne(profile) {
    const llm = await (
      provider === 'anthropic' ? classifyWithClaude(anthropicClient, model, profile) :
      provider === 'openai'    ? classifyWithOpenAI(model, profile) :
      provider === 'gemini'    ? classifyWithGemini(model, profile) :
      provider === 'grok'      ? classifyWithGrok(model, profile) :
      Promise.reject(new Error(`Unknown provider: ${provider}`))
    );
    const { tier, tier_reason } = computeTier(llm, profile);
    return {
      handle:      profile.handle,
      platform:    profile.platform,
      type:        llm.type        || '',
      tier,
      tier_reason,
      reason:      llm.reason      || '',
      uk_based:    llm.uk_based    === true ? true : llm.uk_based === false ? false : null,
      food_focus:  llm.food_focus  === true ? true : llm.food_focus  === false ? false : null,
    };
  }

  const CONCURRENCY = 10;
  const results = [];
  for (let i = 0; i < profiles.length; i += CONCURRENCY) {
    const batch = profiles.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(p => classifyOne(p)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        console.error(`[classify] failed for ${batch[j].handle}:`, s.reason?.message);
        results.push({ handle: batch[j].handle, platform: batch[j].platform, type: '', confidence: 'low', reason: 'Classification failed: ' + s.reason?.message });
      }
    }
  }

  console.log(`[classify] provider=${provider} model=${model} classified=${results.length}`);
  return res.status(200).json({ results });
}
