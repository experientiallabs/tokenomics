// Pure scenario engine shared by the browser explorer, the /api/report endpoint and the CLI.
// No I/O here: callers hand in an already-normalized catalog and a scenario object.
import { economics } from './economics.mjs';

export class ScenarioError extends Error {}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Objects merge recursively and arrays replace, except `gpus`, which also accepts a
// map keyed by GPU id so a caller can patch one price: {"gpus":{"h100":{"hourlyRate":1.5}}}.
// Only the top-level GPU list takes the map form; per-model `gpus` overrides are plain objects.
export function mergeScenario(base, patch, top = true) {
  if (!isObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (top && key === 'gpus' && isObject(value) && Array.isArray(out.gpus)) {
      const gpus = new Map(out.gpus.map(g => [g.id, g]));
      for (const [id, gpu] of Object.entries(value)) {
        if (gpu === null) gpus.delete(id);
        else gpus.set(id, { ...(gpus.get(id) || { id, name: id }), ...gpu, id });
      }
      out.gpus = [...gpus.values()];
    } else if (isObject(value) && isObject(out[key])) out[key] = mergeScenario(out[key], value, false);
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
const optionalNumber = (value, path, range) => value === undefined ? undefined : number(value, path, range);
const patterns = (value, path) => {
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
const throughputOverride = (value, path) => {
  if (!isObject(value)) throw new ScenarioError(`${path} must be an object`);
  return {
    inputTpsPerGpu: optionalNumber(value.inputTpsPerGpu, `${path}.inputTpsPerGpu`),
    outputTpsPerGpu: optionalNumber(value.outputTpsPerGpu, `${path}.outputTpsPerGpu`),
    cacheHitRate: optionalNumber(value.cacheHitRate, `${path}.cacheHitRate`, { max: 1 }),
    throughput: optionalNumber(value.throughput, `${path}.throughput`),
  };
};

function sourcesOf(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(v => !SOURCES.includes(v))) {
    throw new ScenarioError(`catalog.sources must be a non-empty array of: ${SOURCES.join(', ')}`);
  }
  return [...new Set(value)];
}

/** Validates a fully merged scenario and returns a clean copy with only known fields. */
export function validateScenario(s) {
  if (!isObject(s)) throw new ScenarioError('scenario must be a JSON object');
  const lane = s.catalog?.lane;
  if (!['lead', 'cheapest', 'max'].includes(lane)) throw new ScenarioError('catalog.lane must be "lead", "cheapest" or "max"');
  if (!Array.isArray(s.gpus) || s.gpus.length === 0 || s.gpus.length > 50) throw new ScenarioError('gpus must list 1 to 50 GPUs');
  const ids = new Set();
  const gpus = s.gpus.map((g, i) => {
    if (!isObject(g) || typeof g.id !== 'string' || !g.id || ids.has(g.id)) throw new ScenarioError(`gpus[${i}] needs a unique string id`);
    ids.add(g.id);
    return { id: g.id, name: typeof g.name === 'string' ? g.name : g.id,
      hourlyRate: number(g.hourlyRate, `gpus.${g.id}.hourlyRate`), throughput: number(g.throughput, `gpus.${g.id}.throughput`) };
  });
  const models = {};
  for (const [slug, m] of Object.entries(isObject(s.models) ? s.models : {})) {
    const path = `models.${slug}`;
    if (!isObject(m)) throw new ScenarioError(`${path} must be an object`);
    const gpuOverrides = {};
    for (const [id, o] of Object.entries(isObject(m.gpus) ? m.gpus : {})) gpuOverrides[id] = throughputOverride(o, `${path}.gpus.${id}`);
    models[slug] = { ...throughputOverride(m, path),
      gpuCount: optionalNumber(m.gpuCount, `${path}.gpuCount`, { min: 1 }),
      input: optionalNumber(m.input, `${path}.input`), cached: optionalNumber(m.cached, `${path}.cached`),
      output: optionalNumber(m.output, `${path}.output`), gpus: gpuOverrides };
  }
  return {
    catalog: { lane, sources: sourcesOf(s.catalog.sources), openWeightsOnly: Boolean(s.catalog.openWeightsOnly), include: patterns(s.catalog.include ?? [], 'catalog.include'), exclude: patterns(s.catalog.exclude ?? [], 'catalog.exclude'),
      minBlendedPrice: number(s.catalog.minBlendedPrice ?? 0, 'catalog.minBlendedPrice') },
    workload: { inputTpsPerGpu: number(s.workload?.inputTpsPerGpu, 'workload.inputTpsPerGpu'),
      outputTpsPerGpu: number(s.workload?.outputTpsPerGpu, 'workload.outputTpsPerGpu'),
      cacheHitRate: number(s.workload?.cacheHitRate, 'workload.cacheHitRate', { max: 1 }) },
    fleet: { gpuCount: number(s.fleet?.gpuCount, 'fleet.gpuCount', { min: 1 }), hoursPerMonth: number(s.fleet?.hoursPerMonth, 'fleet.hoursPerMonth', { max: 744 }),
      utilization: number(s.fleet?.utilization, 'fleet.utilization', { max: 1 }), otherMonthlyCost: number(s.fleet?.otherMonthlyCost ?? 0, 'fleet.otherMonthlyCost'),
      feeRate: number(s.fleet?.feeRate ?? 0, 'fleet.feeRate', { max: 1 }) },
    gpus, models,
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
        vendor: (m.maker || m.icon || wire?.split('/')[0] || 'unknown').toLowerCase(), openWeights: null, lanes }];
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
const matchesAny = (slug, list) => list.some(p => glob(p).test(slug));

function blendOf(prices, inputShare, cacheHitRate) {
  return inputShare * ((1 - cacheHitRate) * prices.input + cacheHitRate * prices.cached) + (1 - inputShare) * prices.output;
}

function pickPrices(model, override, lane, inputShare, cacheHitRate) {
  const ranked = model.lanes.map(l => ({ ...l, blend: blendOf(l, inputShare, cacheHitRate) }));
  const chosen = lane === 'lead' ? ranked[0]
    : ranked.reduce((best, l) => (lane === 'cheapest' ? l.blend < best.blend : l.blend > best.blend) ? l : best);
  return { provider: chosen.provider, input: override.input ?? chosen.input,
    cached: override.cached ?? chosen.cached, output: override.output ?? chosen.output };
}

const steps = ({ from, to, steps }) => Array.from({ length: steps + 1 }, (_, i) => from + (to - from) * i / steps);

// Overrides key on "source:slug" or the bare slug; an unnamed model gets an empty override.
const overrideFor = (s, model) => s.models[`${model.source}:${model.slug}`] || s.models[model.slug] || null;

function included(s, model, override) {
  if (!s.catalog.sources.includes(model.source)) return false;
  if (override) return true;
  const id = `${model.source}:${model.slug}`, listed = list => matchesAny(model.slug, list) || matchesAny(id, list);
  return !(s.catalog.openWeightsOnly && model.openWeights === false) && (listed(s.catalog.include) || !listed(s.catalog.exclude));
}

/** Per-GPU capacity: a per-model-per-GPU pin wins, else (model or workload default) x GPU x model multipliers. */
function capacityFor(s, override, gpu) {
  const o = override || {}, pinned = o.gpus?.[gpu.id] || {};
  const scale = gpu.throughput * (pinned.throughput ?? o.throughput ?? 1);
  const inputTpsPerGpu = pinned.inputTpsPerGpu ?? (o.inputTpsPerGpu ?? s.workload.inputTpsPerGpu) * scale;
  const outputTpsPerGpu = pinned.outputTpsPerGpu ?? (o.outputTpsPerGpu ?? s.workload.outputTpsPerGpu) * scale;
  const cacheHitRate = pinned.cacheHitRate ?? o.cacheHitRate ?? s.workload.cacheHitRate;
  const total = inputTpsPerGpu + outputTpsPerGpu;
  return { inputTpsPerGpu, outputTpsPerGpu, cacheHitRate, inputShare: total > 0 ? inputTpsPerGpu / total : 0,
    measured: Boolean(pinned.inputTpsPerGpu ?? pinned.outputTpsPerGpu) };
}

/**
 * Computes every included catalog model on every GPU.
 *
 * Per-GPU throughput = (per-model-per-GPU override) else (model override or workload default) x GPU
 * throughput multiplier x model throughput multiplier. Prices come from the chosen catalog lane
 * unless the scenario overrides them.
 */
export function buildReport(catalog, scenario, { curves = false } = {}) {
  const s = validateScenario(scenario);
  const rates = steps(s.sweep.hourlyRate), utils = steps(s.sweep.utilization);
  const models = [];
  for (const model of catalog) {
    const id = `${model.source}:${model.slug}`, override = overrideFor(s, model);
    if (!included(s, model, override)) continue;
    const results = s.gpus.map(gpu => {
      const { inputTpsPerGpu, outputTpsPerGpu, cacheHitRate, inputShare } = capacityFor(s, override, gpu);
      const prices = pickPrices(model, override || {}, s.catalog.lane, inputShare, cacheHitRate);
      const base = { gpus: override?.gpuCount ?? s.fleet.gpuCount, hourlyRate: gpu.hourlyRate, hours: s.fleet.hoursPerMonth,
        utilization: s.fleet.utilization, otherMonthlyCost: s.fleet.otherMonthlyCost, feeRate: s.fleet.feeRate,
        inputPrice: prices.input, cachedPrice: prices.cached, outputPrice: prices.output, inputTpsPerGpu, outputTpsPerGpu, cacheHitRate };
      const e = economics(base);
      // Highest GPU-hour price that still breaks even at the scenario's utilization.
      const netRevenue = e.revenue - e.fees - s.fleet.otherMonthlyCost;
      const result = { gpu: gpu.id, gpuCount: base.gpus, hourlyRate: gpu.hourlyRate, inputTpsPerGpu, outputTpsPerGpu, cacheHitRate,
        lane: prices.provider, prices: { input: prices.input, cached: prices.cached, output: prices.output },
        blendedPrice: e.blend, totalTps: e.totalTps, millionTokensAtFull: e.millionTokensAtFull,
        rent: e.rent, revenue: e.revenue, profit: e.profit, margin: e.margin, breakEvenUtilization: e.breakEvenUtilization,
        breakEvenHourlyRate: base.gpus * s.fleet.hoursPerMonth > 0 ? Math.max(0, netRevenue) / (base.gpus * s.fleet.hoursPerMonth) : null };
      if (curves) {
        result.profitByHourlyRate = rates.map(rate => economics({ ...base, hourlyRate: rate }).profit);
        result.profitByUtilization = utils.map(utilization => economics({ ...base, utilization }).profit);
      }
      return result;
    });
    if (results[0].blendedPrice < s.catalog.minBlendedPrice) continue;
    models.push({ id, source: model.source, slug: model.slug, name: model.name, vendor: model.vendor, results });
  }
  const best = models.map(m => ({ m, r: m.results.reduce((a, b) => b.profit > a.profit ? b : a) })).sort((a, b) => b.r.profit - a.r.profit);
  return {
    scenario: s,
    axes: curves ? { hourlyRate: rates, utilization: utils } : undefined,
    summary: {
      models: models.length,
      profitable: Object.fromEntries(s.gpus.map((g, i) => [g.id, models.filter(m => m.results[i].profit > 0).length])),
      top: best.slice(0, 10).map(({ m, r }) => ({ id: m.id, gpu: r.gpu, profit: r.profit, breakEvenUtilization: r.breakEvenUtilization })),
    },
    models,
  };
}

/**
 * One catalog model on one GPU in the shape the benchmark heatmap (lib/models.mjs) reads,
 * so the original dashboard can draw any catalog model unchanged. Price references are the
 * scenario's price (when overridden) followed by the model's catalog lanes.
 */
export function heatmapModel(catalog, scenario, id, gpuId) {
  const s = validateScenario(scenario);
  const model = catalog.find(m => `${m.source}:${m.slug}` === id);
  if (!model) throw new ScenarioError(`no priced catalog model ${id} in sources ${s.catalog.sources.join(', ')}`);
  const gpu = s.gpus.find(g => g.id === gpuId);
  if (!gpu) throw new ScenarioError(`gpu ${gpuId} is not in the scenario`);
  const override = overrideFor(s, model) || {};
  const c = capacityFor(s, override, gpu);
  const lanes = model.lanes.slice(0, 4).map((l, i) => ({ id: `lane-${i}`, name: `${model.source} · ${l.provider}`, input: l.input, cached: l.cached, output: l.output }));
  const custom = ['input', 'cached', 'output'].some(k => override[k] !== undefined)
    ? [{ id: 'scenario', name: 'Scenario price', ...Object.fromEntries(['input', 'cached', 'output'].map(k => [k, override[k] ?? model.lanes[0][k]])) }] : [];
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: `catalog:${id}:${gpu.id}`, name: model.name, hardware: gpu.name, engine: model.source,
    workload: c.measured ? 'scenario-pinned throughput' : 'generic throughput', capacityKind: c.measured ? 'measured' : 'generic',
    estimateFrom: c.measured ? undefined : 'generic throughput',
    measuredAt: today, pricesAsOf: today,
    inputTpsPerGpu: c.inputTpsPerGpu, outputTpsPerGpu: c.outputTpsPerGpu, cacheHitRate: c.cacheHitRate,
    defaultGpuCount: override.gpuCount ?? s.fleet.gpuCount, defaultHourlyRate: gpu.hourlyRate, defaultHoursPerMonth: s.fleet.hoursPerMonth,
    assumptions: `Catalog model ${id} on ${gpu.name} at $${gpu.hourlyRate}/GPU-hour with a ${gpu.throughput}x throughput multiplier. `
      + (c.measured ? 'Throughput is pinned in the scenario. ' : 'Throughput is the scenario\'s generic placeholder, not a measurement. ')
      + 'Price references are live catalog list prices. Other monthly costs and fees in the scenario are not drawn here; the explorer and report include them.',
    prices: [...custom, ...lanes],
  };
}

/** One CSV row per model x GPU, for spreadsheets. */
export function reportToCsv(report) {
  const cols = ['source', 'slug', 'vendor', 'gpu', 'gpuCount', 'hourlyRate', 'lane', 'input', 'cached', 'output', 'blendedPrice', 'totalTps',
    'rent', 'revenue', 'profit', 'margin', 'breakEvenUtilization', 'breakEvenHourlyRate'];
  const cell = v => v === null || v === undefined ? '' : typeof v === 'number' ? String(+v.toPrecision(8)) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = report.models.flatMap(m => m.results.map(r => [m.source, m.slug, m.vendor, r.gpu, r.gpuCount, r.hourlyRate, r.lane,
    r.prices.input, r.prices.cached, r.prices.output, r.blendedPrice, r.totalTps, r.rent, r.revenue, r.profit, r.margin,
    r.breakEvenUtilization, r.breakEvenHourlyRate].map(cell).join(',')));
  return [cols.join(','), ...lines].join('\n') + '\n';
}
