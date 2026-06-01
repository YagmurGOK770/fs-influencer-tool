// Structured-facts classifier — shared by /api/classify (UI) and scripts/classify-batch.mjs (dataset).
// Extracts entity_type / content category / food-content type / food_post_count / uk_geography from a
// creator's bio + name + location + platform + recent post captions. The rule-based Tier is computed
// separately from these facts (+ engagement), NOT here.

import Anthropic from '@anthropic-ai/sdk';

// The prompt, verbatim (instructions + fields + output schema as system; the INPUT block as user).
export const SYSTEM_PROMPT = `You analyze a social media creator and extract structured facts about
their content. The output feeds an outreach pipeline for the UK app for finding restaurants and takeaway based on cravings, vibe,
dish type, dietary preferences, and ingredient exclusions.
The app is about DINING OUT and TAKEAWAY — not cooking at home.
Creators whose content drives dining decisions matter most.
Evaluate everything provided: bio, display name, location field,
all post captions, platform metadata. Data may come
from Instagram, TikTok, or YouTube — treat all platforms consistently.
Base every judgment on visible evidence, not guesses.
Return JSON only. Use ONLY the values listed for each enum — never
invent new values.
FIELDS
entity_type:
  "individual" — a real person posting first-person content. KEEP.
                 A chef who owns restaurants is still "individual" if
                 the account posts personal content.
  "brand"      — a company, restaurant, magazine, market, publication,
                 hotel, or commercial account. Institutional voice.
                 FILTER.
  "unclear"    — not enough signal to decide.
primary_content_category — the SINGLE dominant theme across visible posts:
  "food"              — identity built around food
  "fitness_wellness"  — training, nutrition, sports
  "fashion_beauty"    — style, beauty
  "travel_lifestyle"  — travel, weekend trips, lifestyle vlogging
  "parenting_family"  — kids, family life
  "business_career"   — career, business, entrepreneurship
  "arts_culture"      — theater, music, art, cultural events
  "general_lifestyle" — "day in my life" / personal vlogging
  "entertainment"     — comedy, celebrity
  "other"             — none of the above
primary_food_content_type — IF food_post_count >= 5, the DOMINANT
format of the food posts. Otherwise null.
  "restaurant_lists"   — themed lists ("top 10 brunches in London")
  "restaurant_reviews" — visiting and reviewing places
  "food_news_culture"  — openings, trends, industry commentary
  "chef_dishes"        — professional cooking, plated dishes
  "travel_food"        — food while travelling
  "recipes"            — structured recipes to cook at home
  "home_meals"         — amateur daily cooking
  "mukbang"            — eating large amounts on camera
  "mixed"              — no single format dominates
food_post_count — integer. How many of the analyzed posts are food,
dining, or cooking related. Count generously: a fitness creator's
meal-prep post counts as food.
total_posts_analyzed — integer. Number of posts visible in the input.
uk_geography — judged PRIMARILY from post evidence. A bio or location
field naming a UK place is a CLAIM, not proof — the posts are the proof.
Among posts that carry ANY location signal, compute the share that is UK
(UK city, region, neighbourhood, venue, or clear UK reference). Posts with
no location signal are excluded from this share — they neither prove nor
disprove UK presence.
  "location_relevant"    — 50%+ of location-bearing posts are UK. Bio can
                      say UK, say elsewhere, or be empty — post proof decides.
  "location_low_proof"   — at least one UK post, but UK posts are under 50%
                      of location-bearing posts.
  "location_unverified"  — NO post carries a UK location signal, but the bio /
                      location field claims the UK. A UK claim with no
                      post-level proof — do not upgrade on the claim alone.
  "location_irrelevant"  — NO post carries a UK location signal AND the bio /
                      location field is empty or names somewhere outside the UK.
OUTPUT
{
  "entity_type": "...",
  "primary_content_category": "...",
  "primary_food_content_type": "..." or null,
  "food_post_count": 0,
  "total_posts_analyzed": 0,
  "uk_geography": "...",
  "reasoning": "one or two sentences; for uk_geography, state the post-level evidence vs the bio claim"
}`;

export function buildUserPrompt(p) {
  const caps = Array.isArray(p.captions) ? p.captions.filter(Boolean) : [];
  return `INPUT
Bio: ${p.bio || '(none)'}
Display name: ${p.full_name || '(none)'}
Location field: ${p.location || '(none)'}
Platform: ${p.platform || '(unknown)'}
Recent post captions: ${caps.length ? caps.join('\n---\n') : '(no posts)'}`;
}

// Enum guards — never let an out-of-list value through (prompt says so, but coerce defensively).
const ENTITY = ['individual', 'brand', 'unclear'];
const CATEGORY = ['food', 'fitness_wellness', 'fashion_beauty', 'travel_lifestyle', 'parenting_family', 'business_career', 'arts_culture', 'general_lifestyle', 'entertainment', 'other'];
const FOOD_TYPE = ['restaurant_lists', 'restaurant_reviews', 'food_news_culture', 'chef_dishes', 'travel_food', 'recipes', 'home_meals', 'mukbang', 'mixed'];
const GEO = ['location_relevant', 'location_low_proof', 'location_unverified', 'location_irrelevant'];
const oneOf = (v, list, fallback = null) => (list.includes(v) ? v : fallback);
const toInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : null; };

function parseResult(text) {
  const clean = String(text).trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  const j = JSON.parse(clean);
  const foodCount = toInt(j.food_post_count) ?? 0;
  return {
    entity_type: oneOf(j.entity_type, ENTITY, 'unclear'),
    primary_content_category: oneOf(j.primary_content_category, CATEGORY, 'other'),
    // Spec: food type only meaningful when >=5 food posts; otherwise null.
    primary_food_content_type: foodCount >= 5 ? oneOf(j.primary_food_content_type, FOOD_TYPE, 'mixed') : null,
    food_post_count: foodCount,
    total_posts_analyzed: toInt(j.total_posts_analyzed) ?? 0,
    uk_geography: oneOf(j.uk_geography, GEO, 'location_irrelevant'),
    reasoning: typeof j.reasoning === 'string' ? j.reasoning.slice(0, 600) : '',
  };
}

const MAX_TOKENS = 500;

async function callClaude(client, model, profile) {
  const msg = await client.messages.create({
    model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(profile) }],
  });
  return parseResult(msg.content[0].text);
}
async function callOpenAI(model, profile) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_completion_tokens: MAX_TOKENS, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserPrompt(profile) }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `OpenAI HTTP ${r.status}`);
  return parseResult(d.choices[0].message.content);
}
async function callGemini(model, profile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: SYSTEM_PROMPT + '\n\n' + buildUserPrompt(profile) }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
  return parseResult(d.candidates[0].content.parts[0].text);
}
async function callGrok(model, profile) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not set');
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserPrompt(profile) }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `xAI HTTP ${r.status}`);
  return parseResult(d.choices[0].message.content);
}

let _anthropic = null;
// profile: { bio, full_name, location, platform, captions: string[] }
export async function classifyCreator(profile, { provider = 'anthropic', model = 'claude-haiku-4-5-20251001' } = {}) {
  if (provider === 'anthropic') {
    _anthropic = _anthropic || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return callClaude(_anthropic, model, profile);
  }
  if (provider === 'openai') return callOpenAI(model, profile);
  if (provider === 'gemini') return callGemini(model, profile);
  if (provider === 'grok')   return callGrok(model, profile);
  throw new Error(`Unknown provider: ${provider}`);
}
