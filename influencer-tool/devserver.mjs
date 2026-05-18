// Local dev server — serves public/ as static files and api/*.js as serverless handlers.
// Run with: node devserver.mjs (from influencer-tool/)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
    if (m) process.env[m[1]] = m[2];
  }
  console.log('[devserver] loaded .env.local');
}

const PORT = 3001;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.replace('/api/', '').replace(/\/$/, '');
    const apiFile = path.join(__dirname, 'api', `${name}.js`);
    if (!fs.existsSync(apiFile)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    try {
      let body = '';
      await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
      req.body = body ? JSON.parse(body) : {};
      console.log(`[devserver] ${req.method} ${url.pathname}`);
      const action = req.body?.action;
      if (action) console.log(`[devserver]   action=${action}${req.body.keyword ? ` keyword="${req.body.keyword}"` : ''}${req.body.platform ? ` platform=${req.body.platform}` : ''}${req.body.searchId ? ` searchId=${req.body.searchId}` : ''}`);

      let statusCode = 200;
      const headers = {};
      const resShim = {
        status(code) { statusCode = code; return resShim; },
        setHeader(k, v) { headers[k] = v; },
        json(data) {
          headers['Content-Type'] = 'application/json';
          res.writeHead(statusCode, headers);
          res.end(JSON.stringify(data));
        },
        end(data) { res.writeHead(statusCode, headers); res.end(data); },
      };

      const fileUrl = `file:///${apiFile.replace(/\\/g, '/')}?t=${Date.now()}`;
      const mod = await import(fileUrl);
      await mod.default(req, resShim);
    } catch (err) {
      console.error('[devserver] handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }

  console.log(`[devserver] ${req.method} ${url.pathname}`);
  let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(PUBLIC, 'index.html');
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  res.end(await readFile(filePath));
});

server.listen(PORT, () => console.log(`[devserver] http://localhost:${PORT}`));
