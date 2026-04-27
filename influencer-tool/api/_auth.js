// Tiny shared-password gate. If APP_PASSWORD is unset, allow all.
// If set, require X-App-Password header from the client to match.

export function checkAuth(req, res) {
  const required = process.env.APP_PASSWORD;
  if (!required) return true;
  const provided = req.headers['x-app-password'];
  if (provided !== required) {
    res.status(401).json({ error: 'Unauthorized — invalid or missing password' });
    return false;
  }
  return true;
}

export function requireApiKey(res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
    return false;
  }
  return true;
}
