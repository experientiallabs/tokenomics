// Estimates AgentX-style capacity for catalog models SemiAnalysis has not measured.
// Pure: shared by the server (/api/estimates, /api/report) and the browser.
//
// Model: log(total tokens/sec/GPU) = a[gpu] + slope x log(input + output list price).
// The slope is shared; each GPU gets its own level a[gpu]. Fitted on the best measured
// point (meeting the 50 tok/s/user target) per model and GPU, priced from our catalog.

// AgentX model key -> Experiential catalog slug, so anchors are priced from the same list.
export const ANCHOR_SLUGS = {
  dsv41flash: 'deepseek-v4.1-flash', dsv4: 'deepseek-v4-pro', 'glm5.3': 'glm-5.3', kimik3: 'kimi-k3',
  minimaxm3: 'minimax-m3', 'qwen3.5': 'qwen3.5-397b-a17b', 'qwen3.8next': 'qwen3.8-flash', 'glm5.1': 'glm-5.1',
};
const sizeOf = lane => lane && lane.input + lane.output > 0 ? Math.log(lane.input + lane.output) : null;
// Chat-style generation only: embeddings (no output price) and image/audio models are not AgentX workloads.
export const estimable = model => model.textOutput !== false && model.lanes[0]?.output > 0;
const mean = values => values.reduce((s, v) => s + v, 0) / values.length;
const median = values => { const s = values.toSorted((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const totalTps = m => m.inputTpsPerGpu + m.outputTpsPerGpu;

/**
 * Fits the estimator.
 *
 * @param measured AgentX entries from lib/benchmarks.mjs (sorted best-first per model and GPU).
 * @param catalog Normalized catalog models ({ slug, lanes: [{ input, cached, output }] }).
 * @returns Compact, JSON-safe fit: slope, per-GPU level and medians, per-model measured levels, quality.
 */
export function fitEstimator(measured, catalog) {
  const bySlug = new Map(catalog.map(m => [m.slug, m]));
  const best = new Map();
  for (const m of measured) {
    const key = `${m.modelKey}|${m.hardwareKey}`;
    if (!best.has(key) && m.targetMet && m.inputShareKnown && m.cacheHitRate !== null) best.set(key, m);
  }
  const points = [...best.values()].map(m => ({ m, x: sizeOf(bySlug.get(ANCHOR_SLUGS[m.modelKey])?.lanes[0]), y: Math.log(totalTps(m)) }))
    .filter(p => p.x !== null);
  if (points.length < 3) throw new Error('Too few priced AgentX measurements to fit an estimate.');
  const byGpu = Map.groupBy(points, p => p.m.hardwareKey);
  // Slope from within-GPU deviations, so GPU speed differences do not leak into it.
  const centered = points.map(p => { const g = byGpu.get(p.m.hardwareKey); return { x: p.x - mean(g.map(q => q.x)), y: p.y - mean(g.map(q => q.y)) }; });
  const sxx = centered.reduce((s, p) => s + p.x * p.x, 0);
  const slope = sxx > 0 ? centered.reduce((s, p) => s + p.x * p.y, 0) / sxx : -1;
  const residuals = centered.map(p => p.y - slope * p.x);
  const syy = centered.reduce((s, p) => s + p.y * p.y, 0);
  const gpus = {};
  for (const [key, group] of byGpu) {
    const sample = group[0].m;
    gpus[key] = { key, label: sample.hardware, level: mean(group.map(p => p.y - slope * p.x)),
      cacheHitRate: median(group.map(p => p.m.cacheHitRate)),
      inputShare: median(group.map(p => p.m.inputTpsPerGpu / totalTps(p.m))),
      rental: sample.rental, anchors: group.map(p => ({ name: p.m.name, tps: totalTps(p.m) })) };
  }
  // A measured model's own level (its measured speed relative to the GPU level), for its unmeasured GPUs.
  const models = {};
  for (const p of points) (models[ANCHOR_SLUGS[p.m.modelKey]] ||= []).push(p.y - gpus[p.m.hardwareKey].level);
  for (const [slug, offsets] of Object.entries(models)) models[slug] = { name: points.find(p => ANCHOR_SLUGS[p.m.modelKey] === slug).m.name, offset: mean(offsets) };
  // Prices outside this range extrapolate the fit; the estimate says so.
  const xs = points.map(p => p.x);
  return { slope, gpus, models, points: points.length, priceRange: [Math.exp(Math.min(...xs)), Math.exp(Math.max(...xs))], r2: syy > 0 ? 1 - residuals.reduce((s, r) => s + r * r, 0) / syy : null,
    typicalErrorFactor: Math.exp(Math.sqrt(mean(residuals.map(r => r * r)))) };
}

/**
 * One catalog model on one GPU, shaped like an AgentX benchmark entry so the dashboard
 * draws it unchanged. Returns null when the model has no list price or the GPU has no anchors.
 */
export function estimateEntry(fit, model, gpuKey, today = new Date().toISOString().slice(0, 10)) {
  const gpu = fit.gpus[gpuKey];
  if (!gpu || !estimable(model)) return null;
  const x = sizeOf(model.lanes[0]), [low, high] = fit.priceRange.map(Math.log);
  const outside = x < low || x > high;
  const own = fit.models[model.slug];
  const logTps = gpu.level + (own ? own.offset : fit.slope * x);
  const tps = Math.exp(logTps);
  const lanes = model.lanes.filter((l, i) => i === 0 || l.input + l.output > 0);
  // Cheapest by the blended price the chart uses (this GPU's mix and cache share), not by list price.
  const blend = l => gpu.inputShare * ((1 - gpu.cacheHitRate) * l.input + gpu.cacheHitRate * l.cached) + (1 - gpu.inputShare) * l.output;
  const cheapest = lanes.reduce((a, b) => blend(b) < blend(a) ? b : a, lanes[0]);
  const prices = [lanes[0], ...(cheapest !== lanes[0] ? [cheapest] : [])].map((l, i) => ({
    id: `catalog-${i}`, name: `${i ? 'Cheapest catalog lane' : 'Catalog price'} · ${l.provider}`, input: l.input, cached: l.cached, output: l.output }));
  const factor = fit.typicalErrorFactor.toFixed(1);
  const basis = own
    ? `${own.name} is measured by SemiAnalysis on other GPUs; this scales its measured speed to ${gpu.label} by how the measured models compare across GPUs.`
    : `Throughput is inferred from this model's list price (input + output $/M) with a fit to ${fit.points} SemiAnalysis AgentX measurements: on the same GPU, throughput falls with price at an exponent of ${fit.slope.toFixed(2)}. ${gpu.label} level set by ${gpu.anchors.map(a => a.name).join(', ')}.${outside ? ` Its price is outside the measured range ($${fit.priceRange[0].toFixed(2)} to $${fit.priceRange[1].toFixed(2)}/M), so this extrapolates and is less reliable.` : ''}`;
  return {
    id: `estimate-${model.slug}-${gpuKey}`, modelKey: `catalog:${model.slug}`, name: model.name,
    hardwareKey: gpuKey, hardware: gpu.label, engine: 'Estimate', setupLabel: own ? `Estimate · scaled from ${own.name} measurements` : `Estimate · price fit to ${fit.points} AgentX points`,
    workload: 'AgentX agentic coding (estimated)', capacityKind: 'estimate', estimateFrom: own ? own.name : 'price fit',
    inputTpsPerGpu: tps * gpu.inputShare, outputTpsPerGpu: tps * (1 - gpu.inputShare), inputShareKnown: true,
    cacheHitRate: gpu.cacheHitRate, cacheKind: `median of measured models on ${gpu.label}`, interactivity: 50,
    defaultGpuCount: 8, measuredGpuCount: null, replicas: 1, rental: gpu.rental, defaultHourlyRate: gpu.rental.rate, defaultHoursPerMonth: 730,
    measuredAt: null, pricesAsOf: today, prices,
    assumptions: [
      `Estimate, not a measurement. ${basis}`,
      `A typical estimate is off by about ${factor}x either way, so treat break-even as a range.`,
      `Input/output mix and cache share are the medians of the measured models on ${gpu.label}. Assumes the model can be self-hosted on 8 GPUs at the 50 tokens/sec/user target; closed models cannot be.`,
      'Prices are our live catalog list prices.',
    ].join(' '),
  };
}
