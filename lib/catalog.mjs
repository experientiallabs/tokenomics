// Fetches the public model catalogs server-side and caches them in memory per process.
import { normalizers } from '../private/tokenomics.mjs';

// Fixed URLs only: callers choose which sources to use, never where to fetch from.
export const SOURCE_URLS = {
  experiential: 'https://api.experientiallabs.ai/api/models?limit=1000',
  huggingface: 'https://router.huggingface.co/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
};
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function fetchSource(source, fetchImpl) {
  const hit = cache.get(source);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const response = await fetchImpl(SOURCE_URLS[source], { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${source} catalog answered HTTP ${response.status}`);
  const value = { models: normalizers[source](await response.json()), fetchedAt: new Date().toISOString() };
  cache.set(source, { at: Date.now(), value });
  return value;
}

/**
 * Loads the requested sources concurrently. A failed source is reported, not fatal,
 * so one catalog outage still leaves the others usable.
 */
export async function loadCatalog(sources, fetchImpl = fetch) {
  const settled = await Promise.allSettled(sources.map(source => fetchSource(source, fetchImpl)));
  const status = {}, models = [];
  settled.forEach((result, i) => {
    const source = sources[i];
    if (result.status === 'fulfilled') {
      status[source] = { ok: true, models: result.value.models.length, fetchedAt: result.value.fetchedAt, url: SOURCE_URLS[source] };
      models.push(...result.value.models);
    } else {
      console.error('Catalog source failed', { source, reason: result.reason?.message });
      status[source] = { ok: false, error: 'Could not load this catalog right now.', url: SOURCE_URLS[source] };
    }
  });
  return { status, models };
}

export function clearCatalogCache() { cache.clear(); }
