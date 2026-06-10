# Rule-based Tier — how it works

The **Tier** (T1–T5, or *Unclassified*) is the outreach-priority score shown in the Results table, the
Overview, sorting, filters, and the CSV export. It is **computed live in code** from the AI
classification facts — primarily the LLM's **`foodstyles_fit`** judgment — plus a few hard guardrails.
The LLM does **not** output a tier; it produces the structured facts and the tier is derived from them.

- **Code:** `bdrTierOf(m)` (the rules) and `bdrEffectiveTier(m)` (manual override + rules) in
  `influencer-tool/public/index.html`.
- **Effective tier** = a **manual override** if one is set; otherwise the **live rule-based tier**.

---

## Rules at a glance (per Tier)

> *Every tier first passes the guardrails* (classified, not a brand, >10k followers, active, some UK).
> "UK-proven" = `location_relevant`; "UK low-proof" = `location_low_proof`.

**T1 — Reach out first**
- `foodstyles_fit = strong_fit`, **and**
- a dining-out **reviewer or list-maker** (`primary_food_content_type` is `restaurant_reviews` or `restaurant_lists`).

**T2 — Approach soon** — either:
- `strong_fit` but **not** a review/list format (e.g. chef dishes, food news); **or**
- `possible_fit` whose only gap is UK (`uk_geography = location_low_proof`).

**T3 — Worth a look**
- `possible_fit` for other reasons (food is a strong secondary theme, or the dining mode only partly matches), **or**
- **any T1/T2 creator whose food is takeaway-led** (see the takeaway cap below).

**T4 — Situational**
- `foodstyles_fit = weak_fit` (food is a minor part, leans home-cooking, or UK only claimed/unverified).

**T5 — Not a fit / out of scope** (a **shown** tier — not hidden)
- `foodstyles_fit = not_a_fit`, **or** any hard guardrail trips (below).

---

## Evaluation order (first match wins)

1. **Unclassified** — `entity_type` is missing **or** `foodstyles_fit` is missing (rows classified before the
   fit field existed → re-run AI Classify to populate). Shown as *Unclassified*, not a tier.
2. **Guardrails → T5** (these override the fit, even a `strong_fit`):
   - `entity_type = brand`
   - **≤ 10,000 followers** on the classified platform
   - **inactive** — most recent post is **older than 6 months** (when the date is known; an unknown
     last-post date does **not** count as inactive)
   - **non-UK** — `uk_geography = location_irrelevant`
3. **Fit → tier:** `not_a_fit` → T5 · `weak_fit` → T4 · `possible_fit` → T2 if UK low-proof else T3 ·
   `strong_fit` → T1 if review/list format else T2.
4. **Takeaway cap:** if `food_service_type = takeaway` and the tier from step 3 is **T1 or T2**, demote
   to **T3**. (Takeaway-led creators can't sit in T1/T2. T3/T4/T5 are unchanged.)

---

## Inputs

Per creator, on their **classified platform** (the top-follower platform), via `bdrGetClass(...)` / the
merged object `m`:

| Input | Source |
|---|---|
| `foodstyles_fit` | classifier — strong_fit / possible_fit / weak_fit / not_a_fit (the primary signal) |
| `uk_geography` | classifier — location_relevant / low_proof / unverified / irrelevant |
| `primary_food_content_type` | classifier — used for the T1 review/list gate |
| `food_service_type` | classifier — dine_in / takeaway / both / unclear (the takeaway cap) |
| `entity_type` | classifier — brand → T5 guardrail |
| `followers` | classified platform's own follower count (`primary_followers`) — ≤10k → T5 |
| `last_post_at` | most recent post date (from `profile_posts`) — >6 months → T5 |

---

## Tier meanings (`BD_TIER_META`)

| Tier | Meaning |
|---|---|
| **T1** | Reach out first — strong fit, dining-out reviewer/list-maker, UK-proven |
| **T2** | Approach soon — strong fit (non-review format) or possible fit with only UK low-proof |
| **T3** | Worth a look — possible fit (food secondary / partial dining mode), or takeaway-capped |
| **T4** | Situational — weak fit (tangential / home-cooking / UK unverified) |
| **T5** | Not a fit / out of scope — brand, <10k followers, inactive (>6mo), or non-UK |

---

## Manual override (`bdrEffectiveTier`)

A persisted manual decision (`tier_manual = true`) bypasses the rules: a manual **T1–T5** wins (shown
with a • marker). Set via the inline Tier dropdown on each Results row, or the ✕ button (which marks a
creator **Tier 5 / out of scope**); "Auto" reverts to the rule-based tier. Legacy hand-marked
"Filtered" rows surface as **T5**.

---

## Where the tier is used

`bdrEffectiveTier` is the single source read by the Results table Tier column, the Tier filter, sorting,
the Overview/Insights tier cards and faceted filters, and the CSV export. It's computed live, so
re-classifying a creator (or editing the rules) updates their tier immediately — no migration needed.
**T5 is shown everywhere** (use the tier filter to hide it); only *Unclassified* rows sit outside the tiers.

---

## Verifying changes to this logic

`scripts/test-tier.mjs` extracts the real `bdrTierOf` from `index.html` and checks it against an
independent reference across every combination of fit × UK × format × service × followers × activity,
plus hand-written spec assertions. Run `node scripts/test-tier.mjs` after any change.
`scripts/backfill-tier.mjs` recomputes and persists the `tier` column using the same extracted logic.
