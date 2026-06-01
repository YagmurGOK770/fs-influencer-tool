// Exhaustive check of the rule-based Tier logic.
//
// Pulls the REAL bdrTierOf() (+ its rule sets) out of public/index.html and runs it against an
// INDEPENDENT reference implementation written straight from the agreed spec, across every
// combination of (entity × category × food-type × density × uk × followers). Any mismatch is a
// transcription bug. Also asserts a set of hand-written spec sentences directly.
//
// Run:  node scripts/test-tier.mjs   (from influencer-tool/)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- Extract the real implementation block (constants + bdrTierRank + bdrTierOf) ---
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

const mineLabel = (facts, followers) => {
  CUR = facts;
  const t = bdrTierOf({ handle: 'x', platforms: ['instagram'], primary_followers: followers });
  return t.status === 'tier' ? 'T' + t.tier : t.status; // 'T1'..'T4' | 'filtered' | 'unclassified'
};

// --- Independent reference implementation (re-derived from the spec text) ---
const REST = ['restaurant_lists', 'restaurant_reviews', 'food_news_culture'];
const GROUP_A = ['fitness_wellness', 'fashion_beauty', 'travel_lifestyle', 'parenting_family', 'business_career', 'arts_culture'];
const GROUP_B = ['general_lifestyle', 'entertainment'];
function ref(facts, followers) {
  if (facts.entity_type == null) return 'unclassified';
  const uk = facts.uk_geography, cat = facts.primary_content_category, ft = facts.primary_food_content_type;
  const tp = Number(facts.total_posts_analyzed) || 0, fc = Number(facts.food_post_count) || 0;
  const density = tp > 0 ? fc / tp : 0;
  if (!(followers > 10000)) return 'filtered';
  if (uk === 'location_irrelevant') return 'filtered';
  const rest = REST.includes(ft);
  if (cat === 'food') {
    if (rest && density >= 0.5 && uk === 'location_relevant') return 'T1';
    if (rest && density >= 0.25 && density < 0.5 && uk === 'location_relevant') return 'T2';
    if (rest && density >= 0.5 && (uk === 'location_low_proof' || uk === 'location_unverified')) return 'T2';
    if (['chef_dishes', 'travel_food', 'mixed'].includes(ft) && density >= 0.5 && uk === 'location_relevant') return 'T2';
    return 'T3';
  }
  if (uk !== 'location_relevant') return 'filtered';
  if (!cat || cat === 'other') return 'filtered';
  if (GROUP_A.includes(cat) && density >= 0.15) return 'T4';
  if (GROUP_B.includes(cat) && density >= 0.25) return 'T4';
  return 'filtered';
}

// --- Enumerate every combination ---
const ENTITIES   = ['individual', 'brand', 'unclear', null];           // null ⇒ unclassified; brand/unclear must behave like individual (entity ignored)
const CATEGORIES = ['food', 'fitness_wellness', 'fashion_beauty', 'travel_lifestyle', 'parenting_family', 'business_career', 'arts_culture', 'general_lifestyle', 'entertainment', 'other', null];
const FOODTYPES  = ['restaurant_lists', 'restaurant_reviews', 'food_news_culture', 'chef_dishes', 'travel_food', 'recipes', 'home_meals', 'mukbang', 'mixed', null];
const UKS        = ['location_relevant', 'location_low_proof', 'location_unverified', 'location_irrelevant', null];
const FOLL       = [5000, 20000];
const TP = 100;
const FCS = [0, 15, 20, 24, 25, 49, 50, 75]; // densities 0/15/20/24/25/49/50/75% — straddles every boundary

let total = 0, mismatches = [];
const dist = {};
for (const entity_type of ENTITIES)
  for (const cat of CATEGORIES)
    for (const ft of FOODTYPES)
      for (const uk of UKS)
        for (const fc of FCS)
          for (const followers of FOLL) {
            const facts = { entity_type, primary_content_category: cat, primary_food_content_type: ft, total_posts_analyzed: TP, food_post_count: fc, uk_geography: uk };
            const a = mineLabel(facts, followers);
            const b = ref(facts, followers);
            total++;
            dist[a] = (dist[a] || 0) + 1;
            if (a !== b && mismatches.length < 30) mismatches.push({ facts: { ...facts, followers }, mine: a, ref: b });
            else if (a !== b) mismatches.push(0);
          }

console.log(`\nEnumerated ${total} combinations.`);
console.log('Distribution (implementation):', JSON.stringify(dist));
const mmCount = mismatches.filter(x => x !== 0).length + mismatches.filter(x => x === 0).length;
if (mismatches.length) {
  console.log(`\n❌ ${mismatches.length} MISMATCH(es) vs reference. First few:`);
  for (const m of mismatches.slice(0, 30)) if (m) console.log('  ', JSON.stringify(m));
} else {
  console.log('\n✅ Implementation matches the independent reference on ALL combinations.');
}

// --- Direct spec-sentence assertions (independent of the reference) ---
const F = (over) => ({ entity_type: 'individual', primary_content_category: 'food', primary_food_content_type: 'restaurant_reviews', total_posts_analyzed: 100, food_post_count: 60, uk_geography: 'location_relevant', ...over });
const cases = [
  ['T1: restaurant_reviews 60% relevant 20k',            F({}),                                                                                  20000, 'T1'],
  ['T2: restaurant_reviews 30% relevant',                F({ food_post_count: 30 }),                                                              20000, 'T2'],
  ['T2: restaurant_reviews 60% low_proof',               F({ uk_geography: 'location_low_proof' }),                                               20000, 'T2'],
  ['T2: restaurant_reviews 60% unverified',              F({ uk_geography: 'location_unverified' }),                                              20000, 'T2'],
  ['T2: chef_dishes 60% relevant',                       F({ primary_food_content_type: 'chef_dishes' }),                                        20000, 'T2'],
  ['T3: chef_dishes 60% low_proof (not T2)',             F({ primary_food_content_type: 'chef_dishes', uk_geography: 'location_low_proof' }),    20000, 'T3'],
  ['T3: recipes 90% relevant',                           F({ primary_food_content_type: 'recipes', food_post_count: 90 }),                       20000, 'T3'],
  ['T3: mukbang 80% relevant',                           F({ primary_food_content_type: 'mukbang', food_post_count: 80 }),                       20000, 'T3'],
  ['T3: restaurant_reviews 20% relevant (low density)',  F({ food_post_count: 20 }),                                                              20000, 'T3'],
  ['T3: restaurant_reviews 30% low_proof (not T2a)',     F({ food_post_count: 30, uk_geography: 'location_low_proof' }),                          20000, 'T3'],
  ['T4: fitness 15% relevant',                           F({ primary_content_category: 'fitness_wellness', primary_food_content_type: 'home_meals', food_post_count: 15 }), 20000, 'T4'],
  ['filtered: fitness 14% relevant (below 15%)',         F({ primary_content_category: 'fitness_wellness', primary_food_content_type: 'home_meals', food_post_count: 14 }), 20000, 'filtered'],
  ['T4: general_lifestyle 25% relevant',                 F({ primary_content_category: 'general_lifestyle', primary_food_content_type: 'home_meals', food_post_count: 25 }), 20000, 'T4'],
  ['filtered: general_lifestyle 20% relevant (below 25%)',F({ primary_content_category: 'general_lifestyle', primary_food_content_type: 'home_meals', food_post_count: 20 }), 20000, 'filtered'],
  ['filtered: <=10k followers (food T1 otherwise)',      F({}),                                                                                  9000,  'filtered'],
  ['filtered: food + location_irrelevant',               F({ uk_geography: 'location_irrelevant' }),                                              20000, 'filtered'],
  ['filtered: non-food + low_proof',                     F({ primary_content_category: 'travel_lifestyle', primary_food_content_type: 'travel_food', uk_geography: 'location_low_proof', food_post_count: 50 }), 20000, 'filtered'],
  ['filtered: other category relevant high density',     F({ primary_content_category: 'other', primary_food_content_type: null, food_post_count: 80 }), 20000, 'filtered'],
  ['brand behaves like individual (entity ignored) → T1',F({ entity_type: 'brand' }),                                                             20000, 'T1'],
  ['unclassified: entity_type null',                     F({ entity_type: null }),                                                                20000, 'unclassified'],
];
let pass = 0, fail = 0;
console.log('\nSpec-sentence assertions:');
for (const [name, facts, foll, want] of cases) {
  const got = mineLabel(facts, foll);
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}  → ${got}${ok ? '' : ` (expected ${want})`}`);
}
console.log(`\n${pass}/${pass + fail} assertions passed.`);
process.exit(mismatches.length || fail ? 1 : 0);
