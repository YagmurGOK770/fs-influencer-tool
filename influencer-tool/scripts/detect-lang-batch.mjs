// Fast bulk language detection — runs locally, no HTTP, parallel LLM calls.
//
// Usage (from influencer-tool/):
//   node scripts/detect-lang-batch.mjs                     # process everything missing language
//   node scripts/detect-lang-batch.mjs --limit 100         # process up to 100 handles (test run)
//   node scripts/detect-lang-batch.mjs --concurrency 20    # 20 LLM calls in flight (default 10)
//   node scripts/detect-lang-batch.mjs --dry-run           # show what would happen, no DB writes
//
// Resumable: only touches rows where `language IS NULL`, so re-running picks up where it left off.
// Every result is appended to scripts/detect-lang-batch.jsonl as it happens — never loses data.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Load .env.local (same parser as devserver.mjs) ──────────────────────────
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
    if (m) process.env[m[1]] = m[2];
  }
}

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const DRY_RUN     = hasFlag('--dry-run');
const LIMIT       = Number(getFlag('--limit')) || Infinity;
const CONCURRENCY = Number(getFlag('--concurrency')) || 10;

const LOG_PATH = path.join(__dirname, 'detect-lang-batch.jsonl');
function log(entry) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

// ── Connect ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Fetch profiles missing language from the profiles table (paginated) ─────
async function fetchMissing(table) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select('handle, bio, post_captions, platform, language')
      .is('language', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

console.log(`[detect-lang-batch] starting (concurrency=${CONCURRENCY}, dry_run=${DRY_RUN})`);
const t0 = Date.now();

const matchRows = await fetchMissing('brightdata_profiles');
console.log(`[detect-lang-batch] fetched: ${matchRows.length} rows missing language`);

// ── Group by handle, aggregate text (so one detection covers all platforms) ─
const byHandle = new Map();

for (const r of matchRows) {
  if (!byHandle.has(r.handle)) byHandle.set(r.handle, { handle: r.handle, captions: [], bios: [] });
  const e = byHandle.get(r.handle);
  if (Array.isArray(r.post_captions)) e.captions.push(...r.post_captions.slice(0, 5));
  if (r.bio) e.bios.push(r.bio);
}

// ── Build to-do list ────────────────────────────────────────────────────────
const todo = [];
let noText = 0;
for (const e of byHandle.values()) {
  let text = e.captions.slice(0, 8).join(' | ');
  if (text.length < 10) {
    text = e.bios.find(b => b && b.length >= 10) || '';
  }
  if (text.trim().length < 5) {
    noText++;
    log({ handle: e.handle, language: null, reason: 'no_text' });
    continue;
  }
  todo.push({ handle: e.handle, text });
  if (todo.length >= LIMIT) break;
}

console.log(`[detect-lang-batch] handles to detect: ${todo.length} (skipped no_text: ${noText})`);
if (DRY_RUN) {
  console.log(`[detect-lang-batch] DRY RUN — would call Claude Haiku ${todo.length} times and update ${todo.length} handles`);
  process.exit(0);
}
if (!todo.length) { console.log('[detect-lang-batch] nothing to do'); process.exit(0); }

// ── Detect with concurrency ─────────────────────────────────────────────────
const results = []; // { handle, lang }
let done = 0;
let errors = 0;
const detectStart = Date.now();

async function detectOne(item) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `What language is this social media post content written in? Reply with ONLY the ISO 639-1 two-letter code (en, tr, es, fr, de, it, nl, pt, ar, ja, ko, zh, etc). Content: "${item.text.slice(0, 600)}"`,
      }],
    });
    const lang = (msg.content[0]?.text?.trim().toLowerCase() || 'unknown').replace(/[^a-z]/g, '').slice(0, 5);
    if (!lang || lang === 'unknown') {
      log({ handle: item.handle, language: null, reason: 'llm_unknown' });
      return { handle: item.handle, lang: null };
    }
    log({ handle: item.handle, language: lang, source: 'claude_haiku', textLen: item.text.length });
    return { handle: item.handle, lang };
  } catch (e) {
    errors++;
    log({ handle: item.handle, language: null, reason: 'llm_error', error: e.message });
    return { handle: item.handle, lang: null, error: e.message };
  }
}

// Process in concurrency-sized chunks
for (let i = 0; i < todo.length; i += CONCURRENCY) {
  const chunk = todo.slice(i, i + CONCURRENCY);
  const chunkResults = await Promise.all(chunk.map(detectOne));
  results.push(...chunkResults);
  done += chunk.length;
  if (done % 100 === 0 || done === todo.length) {
    const secs = (Date.now() - detectStart) / 1000;
    const rate = (done / secs).toFixed(1);
    const eta = secs > 0 ? Math.round((todo.length - done) / (done / secs)) : '?';
    console.log(`[detect-lang-batch] ${done}/${todo.length} (${rate}/s, eta ${eta}s, errors ${errors})`);
  }
}

// ── Batch updates: group by language, one UPDATE per language ───────────────
const byLangMatch = new Map(); // lang -> [handle]
for (const r of results) {
  if (!r.lang) continue;
  if (!byLangMatch.has(r.lang)) byLangMatch.set(r.lang, []);
  byLangMatch.get(r.lang).push(r.handle);
}

async function batchUpdate(table, byLang) {
  let updated = 0;
  for (const [lang, handles] of byLang) {
    // Chunk in case .in() has size limits
    for (let i = 0; i < handles.length; i += 500) {
      const slice = handles.slice(i, i + 500);
      const { error, count } = await supabase
        .from(table)
        .update({ language: lang }, { count: 'exact' })
        .in('handle', slice)
        .is('language', null);
      if (error) console.error(`[detect-lang-batch] update ${table} lang=${lang}: ${error.message}`);
      else updated += count || 0;
    }
  }
  return updated;
}

console.log(`[detect-lang-batch] writing to DB…`);
const updatedMatch = await batchUpdate('brightdata_profiles', byLangMatch);

const total = (Date.now() - t0) / 1000;
console.log(`[detect-lang-batch] DONE in ${total.toFixed(1)}s`);
console.log(`  handles detected:    ${results.filter(r => r.lang).length}`);
console.log(`  llm errors:          ${errors}`);
console.log(`  no_text skipped:     ${noText}`);
console.log(`  rows updated:        ${updatedMatch}`);
console.log(`  log file:            ${LOG_PATH}`);
