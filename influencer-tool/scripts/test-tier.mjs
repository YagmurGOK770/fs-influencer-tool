// Exhaustive check of the rule-based Tier logic (fit-driven T1–T5 model).
//
// Pulls the REAL bdrTierOf() out of public/index.html and runs it against an INDEPENDENT reference
// implementation written straight from the spec, across every combination of
// (entity × foodstyles_fit × uk × food-type × service-type × followers × activity). Any mismatch is
// a transcription bug. Also asserts a set of hand-written spec sentences directly.
//
// Run:  node scripts/test-tier.mjs   (from influencer-tool/)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- Extract the real implementation block (constants + bdrTierRank + bdrTierOf + bdrEffectiveTier) ---
const start = html.indexOf('const BD_TIER_META');
const end   = html.indexOf('async function bdrClassifyVisible');
if (start < 0 || end < 0 || end < start) { console.error('Could not locate bdrTierOf block in index.html'); process.exit(1); }
const code = html.slice(start, end);

// Stubs for the browser-side deps bdrTierOf references.
let CUR = {};
const stubGetClass = () => CUR;                       // returns the facts under test
const bdParseCompact = (v) => Number(v) || 0;          // tests pass plain numbers
const bdFormatCompact = (n) => String(n);
const labelProxy = new Proxy({}, { get: (_, k) => String(k) });
const ukProxy    = new Proxy({}, { get: (_, k) => ({ short: String(k) }) });

const factory = new Function(
  'bdrGetClass', 'bdParseCompact', 'bdFormatCompact', 'BD_UK_META', 'BD_CAT_LABEL', 'BD_FOODTYPE_LABEL',
  code + '\n;return bdrTierOf;'
);
const bdrTierOf = factory(stubGetClass, bdParseCompact, bdFormatCompact, ukProxy, labelProxy, labelProxy);

const mineLabel = (facts, followers, lastPostAt) => {
  CUR = facts;
  const t = bdrTierOf({ handle: 'x', platforms: ['instagram'], primary_followers: followers, last_post_at: lastPostAt });
  return t.status === 'tier' ? 'T' + t.tier : t.status; // 'T1'..'T5' | 'unclassified'
};

// --- Independent reference implementation (re-derived from the spec) ---
const SIX_MONTHS = 1000 * 60 * 60 * 24 * 183;
const T1_FORMATS = ['restaurant_lists', 'restaurant_reviews'];
function ref(facts, followers, lastPostAt) {
  if (facts.entity_type == null || facts.foodstyles_fit == null) return 'unclassified';
  const fit = facts.foodstyles_fit, uk = facts.uk_geography, ft = facts.primary_food_content_type;
  const inactive = lastPostAt != null && (Date.now() - Date.parse(lastPostAt)) > SIX_MONTHS;
  // Guardrails → T5
  if (facts.entity_type === 'brand') return 'T5';
  if (!(followers > 10000)) return 'T5';
  if (inactive) return 'T5';
  if (uk === 'location_irrelevant') return 'T5';
  // Fit → tier
  let tier;
  if (fit === 'not_a_fit') tier = 5;
  else if (fit === 'weak_fit') tier = 4;
  else if (fit === 'possible_fit') tier = (uk === 'location_low_proof') ? 2 : 3;
  else if (fit === 'strong_fit') tier = T1_FORMATS.includes(ft) ? 1 : 2;
  else tier = 5;
  // Takeaway cap
  if (facts.food_service_type === 'takeaway' && (tier === 1 || tier === 2)) tier = 3;
  return 'T' + tier;
}

// --- Enumerate every combination ---
const RECENT = new Date(Date.now() - 10 * 86400000).toISOString();
const OLD    = new Date(Date.now() - 200 * 86400000).toISOString();
const ENTITIES = ['individual', 'brand', 'public_figure', null];
const FITS     = ['strong_fit', 'possible_fit', 'weak_fit', 'not_a_fit', null];
const UKS      = ['location_relevant', 'location_low_proof', 'location_unverified', 'location_irrelevant', null];
const FTS      = ['restaurant_lists', 'restaurant_reviews', 'food_news_culture', 'chef_dishes', null];
const SERVICES = ['dine_in', 'takeaway', 'both', null];
const FOLL     = [5000, 20000];
const POSTS    = [RECENT, OLD, null];

let total = 0; const mismatches = [];
const dist = {};
for (const entity_type of ENTITIES)
  for (const foodstyles_fit of FITS)
    for (const uk of UKS)
      for (const ft of FTS)
        for (const food_service_type of SERVICES)
          for (const followers of FOLL)
            for (const last of POSTS) {
              const facts = { entity_type, foodstyles_fit, uk_geography: uk, primary_food_content_type: ft, food_service_type };
              const a = mineLabel(facts, followers, last);
              const b = ref(facts, followers, last);
              total++;
              dist[a] = (dist[a] || 0) + 1;
              if (a !== b && mismatches.length < 30) mismatches.push({ facts: { ...facts, followers, last }, mine: a, ref: b });
            }

console.log(`\nEnumerated ${total} combinations.`);
console.log('Distribution (implementation):', JSON.stringify(dist));
if (mismatches.length) {
  console.log(`\n❌ ${mismatches.length} MISMATCH(es) vs reference. First few:`);
  for (const m of mismatches.slice(0, 30)) console.log('  ', JSON.stringify(m));
} else {
  console.log('\n✅ Implementation matches the independent reference on ALL combinations.');
}

// --- Direct spec-sentence assertions (independent of the reference) ---
const F = (over) => ({ entity_type: 'individual', foodstyles_fit: 'strong_fit', primary_food_content_type: 'restaurant_reviews', uk_geography: 'location_relevant', food_service_type: 'dine_in', ...over });
const cases = [
  ['T1: strong_fit reviewer, UK-proven, 20k, recent',     F({}),                                                              20000, RECENT, 'T1'],
  ['T2: strong_fit but chef_dishes (non-review format)',  F({ primary_food_content_type: 'chef_dishes' }),                    20000, RECENT, 'T2'],
  ['T2: possible_fit + UK low_proof',                     F({ foodstyles_fit: 'possible_fit', uk_geography: 'location_low_proof' }), 20000, RECENT, 'T2'],
  ['T3: possible_fit + UK relevant (other caveat)',       F({ foodstyles_fit: 'possible_fit' }),                               20000, RECENT, 'T3'],
  ['T3: takeaway caps a T1 reviewer',                     F({ food_service_type: 'takeaway' }),                                20000, RECENT, 'T3'],
  ['T3: takeaway caps a T2 (possible + low_proof)',       F({ foodstyles_fit: 'possible_fit', uk_geography: 'location_low_proof', food_service_type: 'takeaway' }), 20000, RECENT, 'T3'],
  ['T4: weak_fit',                                        F({ foodstyles_fit: 'weak_fit' }),                                   20000, RECENT, 'T4'],
  ['T5: not_a_fit',                                       F({ foodstyles_fit: 'not_a_fit' }),                                  20000, RECENT, 'T5'],
  ['T5 guardrail: brand even when strong_fit',            F({ entity_type: 'brand' }),                                         20000, RECENT, 'T5'],
  ['T5 guardrail: <=10k even when strong_fit',            F({}),                                                              9000,  RECENT, 'T5'],
  ['T5 guardrail: inactive (>6mo) even when strong_fit',  F({}),                                                              20000, OLD,    'T5'],
  ['T5 guardrail: non-UK (location_irrelevant)',          F({ uk_geography: 'location_irrelevant' }),                          20000, RECENT, 'T5'],
  ['Unknown last_post is NOT inactive → still T1',        F({}),                                                              20000, null,   'T1'],
  ['Unclassified: foodstyles_fit null',                   F({ foodstyles_fit: null }),                                         20000, RECENT, 'unclassified'],
  ['Unclassified: entity_type null',                      F({ entity_type: null }),                                            20000, RECENT, 'unclassified'],
];
let pass = 0, fail = 0;
console.log('\nSpec-sentence assertions:');
for (const [name, facts, foll, last, want] of cases) {
  const got = mineLabel(facts, foll, last);
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}  → ${got}${ok ? '' : ` (expected ${want})`}`);
}
console.log(`\n${pass}/${pass + fail} assertions passed.`);
process.exit(mismatches.length || fail ? 1 : 0);
