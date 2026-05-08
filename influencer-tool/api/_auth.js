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

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  gemini:    'GEMINI_API_KEY',
  grok:      'XAI_API_KEY',
};

export function requireApiKey(res, provider = 'anthropic') {
  const envVar = KEY_ENV[provider] || 'ANTHROPIC_API_KEY';
  if (!process.env[envVar]) {
    res.status(500).json({ error: `${envVar} not set in .env.local — add it to use the ${provider} provider` });
    return false;
  }
  return true;
}
