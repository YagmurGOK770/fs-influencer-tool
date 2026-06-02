// GET /api/img?url=<encoded image URL>
// Same-origin proxy for social-CDN images. Instagram/Facebook CDN hosts (*.cdninstagram.com,
// *.fbcdn.net) are widely blocked by ad/tracker blockers (uBlock, Brave, Pi-hole, …) and can carry
// referrer/CORP restrictions, so an <img src="https://scontent…"> shows blank in the browser even
// though the bytes are reachable server-side. Loading them via this same-origin path fixes that.
//
// Unauthenticated by necessity — an <img> tag can't send the app-password header. Kept safe by a
// strict host ALLOWLIST (prevents SSRF to internal/arbitrary hosts), https-only, and an
// image-content-type + size guard. It only ever relays public CDN image bytes.

const ALLOWED_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|ytimg\.com|twimg\.com)$/i;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — thumbnails are tiny; this is just an abuse cap

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end('Method not allowed'); return; }

  // Read the target from the parsed query (Vercel) or the raw request URL (dev server).
  // Primary param is ?u= (base64 of the URL) so the request line carries no "cdninstagram.com"
  // substring for blockers to pattern-match; ?url= (plain) is accepted as a fallback.
  let target;
  try {
    const qs   = new URL(req.url, 'http://localhost').searchParams;
    const b64  = (req.query && req.query.u)   || qs.get('u');
    const plain = (req.query && req.query.url) || qs.get('url');
    let raw = plain || '';
    if (b64) { try { raw = Buffer.from(String(b64), 'base64').toString('utf8'); } catch { raw = ''; } }
    if (!raw) { res.status(400).end('url required'); return; }
    target = new URL(raw);
  } catch { res.status(400).end('bad url'); return; }

  if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) {
    res.status(403).end('host not allowed');
    return;
  }

  try {
    const upstream = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' },
    });
    if (!upstream.ok) { res.status(upstream.status).end('upstream ' + upstream.status); return; }
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) { res.status(415).end('not an image'); return; }
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) { res.status(413).end('too large'); return; }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) { res.status(413).end('too large'); return; }

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache a day; CDN URLs are stable-ish
    res.status(200).end(buf);
  } catch (e) {
    res.status(502).end('fetch failed');
  }
}
