// Report engine shared by /api/report and report.mjs. Every catalog model on every AgentX GPU:
// SemiAnalysis measurements where they exist, the price-fit estimate (private/estimate.mjs) elsewhere,
// and any number the scenario pins on top. No I/O here.
import { economics } from './economics.mjs';
import { ANCHOR_SLUGS, estimateEntry } from './estimate.mjs';

export class ScenarioError extends Error {}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge, everything else replaces, null deletes the key. */
export function mergeScenario(base, patch) {
  if (!isObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isObject(value) && isObject(out[key])) out[key] = mergeScenario(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}

const number = (value, path, { min = 0, max = Infinity } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ScenarioError(`${path} must be a number between ${min} and ${max}`);
  }
  return value;
};
const optional = (value, path, range) => value === undefined ? undefined : number(value, path, range);
const strings = (value, path) => {
  if (!Array.isArray(value) || value.some(p => typeof p !== 'string')) throw new ScenarioError(`${path} must be an array of strings`);
  return value;
};
const range = (value, path, bounds) => {
  if (!isObject(value)) throw new ScenarioError(`${path} must be an object`);
  const from = number(value.from, `${path}.from`, bounds), to = number(value.to, `${path}.to`, bounds);
  const steps = number(value.steps, `${path}.steps`, { min: 1, max: 200 });
  if (to < from || !Number.isInteger(steps)) throw new ScenarioError(`${path} needs from <= to and an integer steps`);
  return { from, to, steps };
};
const capacity = (value, path) => {
  if (!isObject(value)) throw new ScenarioError(`${path} must be an object`);
  return { inputTpsPerGpu: optional(value.inputTpsPerGpu, `${path}.inputTpsPerGpu`), outputTpsPerGpu: optional(value.outputTpsPerGpu, `${path}.outputTpsPerGpu`),
    cacheHitRate: optional(value.cacheHitRate, `${path}.cacheHitRate`, { max: 1 }) };
};

/** Validates a fully merged scenario against the GPUs the fit knows; returns a clean copy. */
export function validateScenario(s, gpuKeys) {
  if (!isObject(s) || !isObject(s.catalog) || !isObject(s.fleet)) throw new ScenarioError('scenario needs catalog and fleet objects');
  const sources = s.catalog.sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.some(v => !SOURCES.includes(v))) {
    throw new ScenarioError(`catalog.sources must be a non-empty array of: ${SOURCES.join(', ')}`);
  }
  const gpus = {};
  for (const [key, g] of Object.entries(isObject(s.gpus) ? s.gpus : {})) {
    if (!gpuKeys.includes(key)) throw new ScenarioError(`gpus.${key} is not an AgentX GPU; use one of: ${gpuKeys.join(', ')}`);
    if (!isObject(g)) throw new ScenarioError(`gpus.${key} must be an object or null`);
    gpus[key] = { hourlyRate: optional(g.hourlyRate, `gpus.${key}.hourlyRate`) };
  }
  const models = {};
  for (const [slug, m] of Object.entries(isObject(s.models) ? s.models : {})) {
    const path = `models.${slug}`;
    if (!isObject(m)) throw new ScenarioError(`${path} must be an object`);
    const pinned = {};
    for (const [key, o] of Object.entries(isObject(m.gpus) ? m.gpus : {})) pinned[key] = capacity(o, `${path}.gpus.${key}`);
    models[slug] = { input: optional(m.input, `${path}.input`), cached: optional(m.cached, `${path}.cached`), output: optional(m.output, `${path}.output`), gpus: pinned };
  }
  return {
    catalog: { sources: [...new Set(sources)], include: strings(s.catalog.include ?? [], 'catalog.include'), exclude: strings(s.catalog.exclude ?? [], 'catalog.exclude'),
      openWeightsOnly: Boolean(s.catalog.openWeightsOnly) },
    fleet: { gpuCount: number(s.fleet.gpuCount, 'fleet.gpuCount', { min: 1 }), hoursPerMonth: number(s.fleet.hoursPerMonth, 'fleet.hoursPerMonth', { max: 744 }),
      utilization: number(s.fleet.utilization, 'fleet.utilization', { max: 1 }), otherMonthlyCost: number(s.fleet.otherMonthlyCost ?? 0, 'fleet.otherMonthlyCost'),
      feeRate: number(s.fleet.feeRate ?? 0, 'fleet.feeRate', { max: 1 }) },
    gpus: Object.keys(isObject(s.gpus) ? s.gpus : {}).length ? gpus : Object.fromEntries(gpuKeys.map(k => [k, {}])),
    models,
    sweep: { hourlyRate: range(s.sweep?.hourlyRate, 'sweep.hourlyRate'), utilization: range(s.sweep?.utilization, 'sweep.utilization', { min: 0, max: 1 }) },
  };
}

const usdPerMillion = nano => typeof nano === 'number' && nano > 0 ? nano / 1e9 : null;
const positive = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const lane = (provider, input, cached, output) => input === null && output === null ? null
  : { provider, input: input ?? 0, cached: cached ?? input ?? 0, output: output ?? 0 };

/**
 * One normalizer per public catalog. Each returns
 * [{ source, slug, name, vendor, openWeights, lanes: [{ provider, input, cached, output }] }]
 * with prices in USD per million tokens and lanes in the source's preferred order.
 * openWeights is true/false when the source says, null when it does not.
 */
export const normalizers = {
  // Experiential GET /api/models. Platform-funded lanes only (BYOK lanes carry the customer's price),
  // ordered by the platform's serving waterfall so "lead" is what we charge.
  experiential(raw) {
    return (Array.isArray(raw?.models) ? raw.models : []).flatMap(row => {
      const m = row.model || {}, order = row.default_provider_ids || [];
      const lanes = (row.providers || []).filter(p => p.billing_source === 'host_managed')
        .map(p => ({ rank: order.includes(p.id) ? order.indexOf(p.id) : order.length,
          lane: lane(p.provider, usdPerMillion(p.input_nano_usd_per_million), usdPerMillion(p.cached_input_nano_usd_per_million), usdPerMillion(p.output_nano_usd_per_million)) }))
        .filter(l => l.lane).sort((a, b) => a.rank - b.rank).map(l => l.lane);
      if (!m.slug || lanes.length === 0) return [];
      const wire = (row.providers || []).map(p => p.provider_model_id).find(id => typeof id === 'string' && id.includes('/'));
      return [{ source: 'experiential', slug: m.slug, name: m.display_name || m.slug,
        vendor: (m.maker || m.icon || wire?.split('/')[0] || 'unknown').toLowerCase(), openWeights: null,
        textOutput: !Array.isArray(m.output_modalities) || m.output_modalities.includes('text'), lanes }];
    });
  },
  // Hugging Face Inference Providers router GET /v1/models. Every model is an open-weights Hub repo.
  huggingface(raw) {
    return (Array.isArray(raw?.data) ? raw.data : []).flatMap(m => {
      const lanes = (m.providers || []).filter(p => p.status !== 'offline' && !p.is_free)
        .map(p => lane(p.provider, positive(p.pricing?.input), null, positive(p.pricing?.output))).filter(Boolean);
      if (typeof m.id !== 'string' || lanes.length === 0) return [];
      return [{ source: 'huggingface', slug: m.id, name: m.id.split('/').pop(), vendor: String(m.owned_by || m.id.split('/')[0]).toLowerCase(), openWeights: true, lanes }];
    });
  },
  // OpenRouter GET /api/v1/models. Prices are USD per token; open weights when it links a Hub repo.
  openrouter(raw) {
    const perMillion = v => { const n = positive(v); return n === null ? null : Math.round(n * 1e12) / 1e6; };
    return (Array.isArray(raw?.data) ? raw.data : []).flatMap(m => {
      const l = lane('openrouter', perMillion(m.pricing?.prompt), perMillion(m.pricing?.input_cache_read), perMillion(m.pricing?.completion));
      if (typeof m.id !== 'string' || !l) return [];
      return [{ source: 'openrouter', slug: m.id, name: m.name || m.id, vendor: m.id.split('/')[0].toLowerCase(), openWeights: Boolean(m.hugging_face_id), lanes: [l] }];
    });
  },
};
export const SOURCES = Object.keys(normalizers);

const glob = pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
const matchesAny = (value, list) => list.some(p => glob(p).test(value));
const steps = ({ from, to, steps }) => Array.from({ length: steps + 1 }, (_, i) => from + (to - from) * i / steps);

/**
 * Every included catalog model on every scenario GPU.
 *
 * Per model and GPU the capacity is, in order: numbers pinned in scenario.models[slug].gpus[gpu],
 * the best SemiAnalysis measurement (Experiential catalog slugs only), else the estimate.
 * Prices: scenario.models[slug] overrides, else the catalog lead lane.
 *
 * @param catalog Normalized catalog models.
 * @param measured AgentX entries (lib/benchmarks.mjs).
 * @param fit Output of fitEstimator.
 */
export function buildReport(catalog, measured, fit, scenario, { curves = false } = {}) {
  const s = validateScenario(scenario, Object.keys(fit.gpus));
  const rates = steps(s.sweep.hourlyRate), utils = steps(s.sweep.utilization);
  const measuredBy = new Map();
  for (const m of measured) {
    const slug = ANCHOR_SLUGS[m.modelKey];
    const key = `${slug}|${m.hardwareKey}`;
    if (slug && !measuredBy.has(key)) measuredBy.set(key, m);
  }
  const models = [];
  for (const model of catalog) {
    if (!s.catalog.sources.includes(model.source)) continue;
    const id = `${model.source}:${model.slug}`, override = s.models[id] || s.models[model.slug];
    const listed = list => matchesAny(model.slug, list) || matchesAny(id, list);
    if (!override && (s.catalog.openWeightsOnly && model.openWeights === false || !listed(s.catalog.include) && listed(s.catalog.exclude))) continue;
    const results = [];
    for (const [gpuKey, gpuPatch] of Object.entries(s.gpus)) {
      const found = model.source === 'experiential' ? measuredBy.get(`${model.slug}|${gpuKey}`) : undefined;
      const entry = found || estimateEntry(fit, model, gpuKey);
      if (!entry) continue;
      const pin = override?.gpus[gpuKey] || {};
      const lead = model.lanes[0];
      const prices = { input: override?.input ?? lead.input, cached: override?.cached ?? lead.cached, output: override?.output ?? lead.output };
      const base = { gpus: s.fleet.gpuCount, hourlyRate: gpuPatch.hourlyRate ?? entry.defaultHourlyRate, hours: s.fleet.hoursPerMonth,
        utilization: s.fleet.utilization, otherMonthlyCost: s.fleet.otherMonthlyCost, feeRate: s.fleet.feeRate,
        inputPrice: prices.input, cachedPrice: prices.cached, outputPrice: prices.output,
        inputTpsPerGpu: pin.inputTpsPerGpu ?? entry.inputTpsPerGpu, outputTpsPerGpu: pin.outputTpsPerGpu ?? entry.outputTpsPerGpu,
        cacheHitRate: pin.cacheHitRate ?? entry.cacheHitRate ?? 0 };
      const e = economics(base);
      const netRevenue = e.revenue - e.fees - s.fleet.otherMonthlyCost;
      const result = { gpu: gpuKey, kind: Object.keys(pin).some(k => pin[k] !== undefined) ? 'pinned' : found ? 'measured' : 'estimate',
        gpuCount: base.gpus, hourlyRate: base.hourlyRate, inputTpsPerGpu: base.inputTpsPerGpu, outputTpsPerGpu: base.outputTpsPerGpu, cacheHitRate: base.cacheHitRate,
        lane: lead.provider, prices, blendedPrice: e.blend, totalTps: e.totalTps, millionTokensAtFull: e.millionTokensAtFull,
        rent: e.rent, revenue: e.revenue, profit: e.profit, margin: e.margin, breakEvenUtilization: e.breakEvenUtilization,
        // Highest GPU-hour price that still breaks even at the scenario's utilization.
        breakEvenHourlyRate: Math.max(0, netRevenue) / (base.gpus * s.fleet.hoursPerMonth) };
      if (curves) {
        result.profitByHourlyRate = rates.map(hourlyRate => economics({ ...base, hourlyRate }).profit);
        result.profitByUtilization = utils.map(utilization => economics({ ...base, utilization }).profit);
      }
      results.push(result);
    }
    if (results.length) models.push({ id, source: model.source, slug: model.slug, name: model.name, vendor: model.vendor, results });
  }
  const best = models.map(m => ({ m, r: m.results.reduce((a, b) => b.profit > a.profit ? b : a) })).sort((a, b) => b.r.profit - a.r.profit);
  return {
    scenario: s,
    estimator: { slope: fit.slope, points: fit.points, r2: fit.r2, typicalErrorFactor: fit.typicalErrorFactor },
    axes: curves ? { hourlyRate: rates, utilization: utils } : undefined,
    summary: {
      models: models.length,
      profitable: Object.fromEntries(Object.keys(s.gpus).map(g => [g, models.filter(m => m.results.find(r => r.gpu === g)?.profit > 0).length])),
      top: best.slice(0, 10).map(({ m, r }) => ({ id: m.id, gpu: r.gpu, kind: r.kind, profit: r.profit, breakEvenUtilization: r.breakEvenUtilization })),
    },
    models,
  };
}

/** One CSV row per model x GPU, for spreadsheets. */
export function reportToCsv(report) {
  const cols = ['source', 'slug', 'vendor', 'gpu', 'kind', 'gpuCount', 'hourlyRate', 'lane', 'input', 'cached', 'output', 'blendedPrice', 'totalTps',
    'rent', 'revenue', 'profit', 'margin', 'breakEvenUtilization', 'breakEvenHourlyRate'];
  const cell = v => v === null || v === undefined ? '' : typeof v === 'number' ? String(+v.toPrecision(8)) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = report.models.flatMap(m => m.results.map(r => [m.source, m.slug, m.vendor, r.gpu, r.kind, r.gpuCount, r.hourlyRate, r.lane,
    r.prices.input, r.prices.cached, r.prices.output, r.blendedPrice, r.totalTps, r.rent, r.revenue, r.profit, r.margin,
    r.breakEvenUtilization, r.breakEvenHourlyRate].map(cell).join(',')));
  return [cols.join(','), ...lines].join('\n') + '\n';
}
