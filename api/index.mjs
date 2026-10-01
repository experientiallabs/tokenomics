import { readFileSync } from 'node:fs';
import { models } from '../lib/models.mjs';

// Serve only these public assets, never arbitrary paths or local configuration.
const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../private/index.html', import.meta.url)]],
  ['/app.css', ['text/css; charset=utf-8', new URL('../private/app.css', import.meta.url)]],
  ['/app.mjs', ['text/javascript; charset=utf-8', new URL('../private/app.mjs', import.meta.url)]],
  ['/economics.mjs', ['text/javascript; charset=utf-8', new URL('../private/economics.mjs', import.meta.url)]],
  ['/d3.min.js', ['text/javascript; charset=utf-8', new URL('../node_modules/d3/dist/d3.min.js', import.meta.url)]],
]);
const legacySignInPaths = new Set(['/signin', '/auth/google', '/auth/callback', '/auth/signout']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  const send = (status, content, type = 'text/plain; charset=utf-8') => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.end(req.method === 'HEAD' ? undefined : content);
  };
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Method not allowed');
    }
    const path = new URL(req.url, 'https://request.invalid').pathname;
    if (legacySignInPaths.has(path)) {
      res.statusCode = 303;
      res.setHeader('Location', '/');
      return res.end();
    }
    if (path === '/health') return send(200, '{"ok":true}', 'application/json');
    if (path === '/robots.txt') return send(200, 'User-agent: *\nAllow: /\n');
    if (path === '/favicon.svg') return send(200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#10151d"/><path d="M8 24V18M16 24V12M24 24V6" stroke="#b8ef5d" stroke-width="4"/></svg>', 'image/svg+xml');
    if (path === '/api/models') return send(200, JSON.stringify({ models }), 'application/json');
    const asset = assets.get(path);
    if (asset) return send(200, readFileSync(asset[1]), asset[0]);
    return send(404, 'Not found');
  } catch (error) {
    console.error('Tokenomics request failed', { code: error?.code || error?.name || 'unknown' });
    return send(503, 'The dashboard is temporarily unavailable. Please try again.');
  }
}
