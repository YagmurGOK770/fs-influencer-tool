// GET /api/manual-coverage
// Returns all manual_influencers with a "found" flag indicating whether
// the tool has discovered them in the influencers table.
// Matching is by name (case-insensitive, partial) — fuzzy enough to catch
// slight spelling differences but strict enough to avoid false positives.

import { createClient } from '@supabase/supabase-js';
import { checkAuth } from './_auth.js';

// Normalise a name for comparison: lowercase, strip punctuation, collapse spaces
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Two names match if one contains the other (after normalisation), or if they
// share at least 70% of their characters (Jaccard on word sets).
function namesMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  // Word-set Jaccard
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && intersection / union >= 0.5;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkAuth(req, res)) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const [manualRes, toolRes] = await Promise.all([
    supabase.from('manual_influencers').select('*').order('name', { ascending: true }),
    supabase.from('influencers').select('handle, name, platform, ig_handle, tt_handle, yt_handle, x_handle, followers, ig_followers, tt_followers, yt_followers, x_followers, content_labels, location, bucket'),
  ]);

  if (manualRes.error) return res.status(500).json({ error: manualRes.error.message });
  if (toolRes.error)   return res.status(500).json({ error: toolRes.error.message });

  const manual = manualRes.data || [];
  const tool   = toolRes.data   || [];

  // Build index of tool influencers by normalised name and by handle for O(1) lookup
  const toolByHandle = new Map(tool.map(t => [t.handle, t]));
  const toolByName   = new Map(tool.map(t => [normName(t.name), t]));

  const rows = manual.map(m => {
    // Try exact handle match first
    let match = toolByHandle.get(m.handle) || null;

    // Then try name-based fuzzy match
    if (!match) {
      const mn = normName(m.name);
      match = toolByName.get(mn) || null;
      if (!match) {
        // Iterate tool entries for partial match (only if no exact key hit)
        for (const t of tool) {
          if (namesMatch(m.name, t.name)) { match = t; break; }
        }
      }
    }

    return {
      // Manual data
      handle:       m.handle,
      name:         m.name,
      platform:     m.platform,
      igHandle:     m.ig_handle,
      ttHandle:     m.tt_handle,
      ytHandle:     m.yt_handle,
      xHandle:      m.x_handle,
      followers:    m.followers,
      location:     m.location,
      bucket:       m.bucket,
      notes:        m.notes,
      niche:        m.niche,
      // Coverage
      found:        !!match,
      toolHandle:   match?.handle   || null,
      toolFollowers:match?.followers || match?.ig_followers || match?.tt_followers || match?.yt_followers || null,
      toolBucket:   match?.bucket   || null,
      toolLabels:   match?.content_labels || null,
    };
  });

  const foundCount   = rows.filter(r => r.found).length;
  const missingCount = rows.length - foundCount;

  return res.status(200).json({
    total:   rows.length,
    found:   foundCount,
    missing: missingCount,
    rows,
  });
}
