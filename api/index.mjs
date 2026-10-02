import { readFileSync } from 'node:fs';
import { models } from '../lib/models.mjs';
import { loadCatalog, SOURCE_URLS } from '../lib/catalog.mjs';
import { buildReport, heatmapModel, mergeScenario, reportToCsv, ScenarioError, SOURCES } from '../private/tokenomics.mjs';

const defaultScenarioUrl = new URL('../private/default-scenario.json', import.meta.url);
export const defaultScenario = () => JSON.parse(readFileSync(defaultScenarioUrl, 'utf8'));
const MAX_BODY_BYTES = 256 * 1024;

// Serve only these public assets, never arbitrary paths or local configuration.
const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../private/index.html', import.meta.url)]],
  ['/app.css', ['text/css; charset=utf-8', new URL('../private/app.css', import.meta.url)]],
  ['/app.mjs', ['text/javascript; charset=utf-8', new URL('../private/app.mjs', import.meta.url)]],
  ['/economics.mjs', ['text/javascript; charset=utf-8', new URL('../private/economics.mjs', import.meta.url)]],
  ['/explorer', ['text/html; charset=utf-8', new URL('../private/explorer.html', import.meta.url)]],
  ['/explorer.css', ['text/css; charset=utf-8', new URL('../private/explorer.css', import.meta.url)]],
  ['/explorer.mjs', ['text/javascript; charset=utf-8', new URL('../private/explorer.mjs', import.meta.url)]],
  ['/tokenomics.mjs', ['text/javascript; charset=utf-8', new URL('../private/tokenomics.mjs', import.meta.url)]],
  ['/default-scenario.json', ['application/json', defaultScenarioUrl]],
  ['/d3.min.js', ['text/javascript; charset=utf-8', new URL('../node_modules/d3/dist/d3.min.js', import.meta.url)]],
]);
const legacySignInPaths = new Set(['/signin', '/auth/google', '/auth/callback', '/auth/signout']);

class BadRequest extends Error {}

async function readJsonBody(req) {
  // Vercel may hand over a pre-parsed body; a plain Node server streams it.
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('Scenario body is larger than 256 KB.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function report(req, url, catalogLoader) {
  let patch;
  try {
    patch = req.method === 'POST' ? await readJsonBody(req) : JSON.parse(url.searchParams.get('scenario') || '{}');
  } catch (error) {
    throw error instanceof BadRequest ? error : new BadRequest('Scenario must be valid JSON.');
  }
  const scenario = mergeScenario(defaultScenario(), patch);
  const sources = Array.isArray(scenario.catalog?.sources) ? scenario.catalog.sources.filter(s => SOURCES.includes(s)) : [];
  const catalog = await catalogLoader(sources);
  const result = buildReport(catalog.models, scenario, { curves: ['1', 'true'].includes(url.searchParams.get('curves')) });
  return { generatedAt: new Date().toISOString(), sources: catalog.status, ...result };
}

export function createHandler({ catalogLoader = loadCatalog } = {}) { return (req, res) => handle(req, res, catalogLoader); }
export default createHandler();

async function handle(req, res, catalogLoader) {
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
    const url = new URL(req.url, 'https://request.invalid'), path = url.pathname;
    if (path === '/api/report' && ['GET', 'HEAD', 'POST'].includes(req.method)) {
      try {
        const result = await report(req, url, catalogLoader);
        if (url.searchParams.get('format') === 'csv') return send(200, reportToCsv(result), 'text/csv; charset=utf-8');
        return send(200, JSON.stringify(result), 'application/json');
      } catch (error) {
        if (error instanceof BadRequest || error instanceof ScenarioError) return send(400, JSON.stringify({ error: error.message }), 'application/json');
        throw error;
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', path === '/api/report' ? 'GET, HEAD, POST' : 'GET, HEAD');
      return send(405, 'Method not allowed');
    }
    if (path === '/api/heatmap-model') {
      // One catalog model on one GPU, shaped like /api/models entries, for the original heatmap.
      try {
        let patch;
        try { patch = JSON.parse(url.searchParams.get('scenario') || '{}'); } catch { throw new BadRequest('Scenario must be valid JSON.'); }
        const scenario = mergeScenario(defaultScenario(), patch);
        const id = url.searchParams.get('id') || '', gpu = url.searchParams.get('gpu') || '';
        const source = id.split(':')[0];
        if (!SOURCES.includes(source)) throw new BadRequest(`id must look like source:slug with a source of ${SOURCES.join(', ')}`);
        const catalog = await catalogLoader([source]);
        const model = heatmapModel(catalog.models, { ...scenario, catalog: { ...scenario.catalog, sources: [source] } }, id, gpu);
        const query = encodeURIComponent(JSON.stringify(patch));
        model.sourceLinks = [['Catalog API', SOURCE_URLS[source]], ['Report for this scenario', `/api/report?scenario=${query}`], ['Open in explorer', '/explorer']];
        return send(200, JSON.stringify({ model }), 'application/json');
      } catch (error) {
        if (error instanceof BadRequest || error instanceof ScenarioError) return send(400, JSON.stringify({ error: error.message }), 'application/json');
        throw error;
      }
    }
    if (path === '/api/scenario') return send(200, JSON.stringify(defaultScenario()), 'application/json');
    if (path === '/api/catalog') {
      const requested = (url.searchParams.get('sources') || defaultScenario().catalog.sources.join(',')).split(',').filter(s => SOURCES.includes(s));
      if (requested.length === 0) return send(400, JSON.stringify({ error: `sources must name one of: ${SOURCES.join(', ')}` }), 'application/json');
      const catalog = await catalogLoader(requested);
      return send(200, JSON.stringify({ sources: catalog.status, models: catalog.models }), 'application/json');
    }
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
