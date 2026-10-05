// Fits the estimator from AgentX measurements and the live Experiential catalog.
import { models as measured } from './benchmarks.mjs';
import { loadCatalog } from './catalog.mjs';
import { estimable, fitEstimator } from '../private/estimate.mjs';
import { buildReport, SOURCES } from '../private/tokenomics.mjs';

/**
 * Returns the fit plus the compact catalog the dashboard needs to build estimates in the browser.
 * The catalog loader caches for ten minutes, so this is cheap after the first call.
 */
export async function loadEstimates(catalogLoader = loadCatalog) {
  const catalog = await catalogLoader(['experiential']);
  if (!catalog.status.experiential?.ok) throw new Error('The Experiential catalog is unavailable.');
  const fit = fitEstimator(measured, catalog.models);
  return {
    fit, fetchedAt: catalog.status.experiential.fetchedAt,
    catalog: catalog.models.filter(estimable).map(({ slug, name, vendor, textOutput, lanes }) => ({ slug, name, vendor, textOutput, lanes: lanes.slice(0, 6) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Runs a report for a partial scenario: same code path for /api/report and report.mjs. */
export async function runReport(scenario, { curves = false, catalogLoader = loadCatalog } = {}) {
  const sources = Array.isArray(scenario.catalog?.sources) ? scenario.catalog.sources.filter(s => SOURCES.includes(s)) : [];
  const [catalog, anchors] = await Promise.all([catalogLoader(sources), catalogLoader(['experiential'])]);
  if (!anchors.status.experiential?.ok) throw new Error('The Experiential catalog is unavailable, so estimates cannot be priced.');
  const fit = fitEstimator(measured, anchors.models);
  return { generatedAt: new Date().toISOString(), sources: catalog.status, ...buildReport(catalog.models, measured, fit, scenario, { curves }) };
}
