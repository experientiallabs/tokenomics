import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../api/index.mjs';
import { loadCatalog, clearCatalogCache, SOURCE_URLS } from '../lib/catalog.mjs';
import { buildReport, mergeScenario, normalizers, reportToCsv, ScenarioError } from '../private/tokenomics.mjs';

const defaults = JSON.parse(readFileSync(new URL('../private/default-scenario.json', import.meta.url), 'utf8'));

// Trimmed shapes of the three live catalog responses (2026-10-01).
const raw = {
  experiential: { models: [
    { model: { slug: 'kimi-k3', display_name: 'Kimi K3', maker: 'Moonshot AI' }, default_provider_ids: ['lead', 'second'], providers: [
      { id: 'byok', provider: 'azure_openai', billing_source: 'customer_managed', input_nano_usd_per_million: null, output_nano_usd_per_million: null },
      { id: 'second', provider: 'wafer', billing_source: 'host_managed', input_nano_usd_per_million: 3e9, cached_input_nano_usd_per_million: 3e8, output_nano_usd_per_million: 12.75e9 },
      { id: 'lead', provider: 'experiential_cloud', billing_source: 'host_managed', input_nano_usd_per_million: 3e9, cached_input_nano_usd_per_million: 3e8, output_nano_usd_per_million: 15e9 },
    ] },
    { model: { slug: 'claude-fable-5.1', display_name: 'Claude Fable 5.1', icon: 'anthropic' }, default_provider_ids: [], providers: [
      { id: 'a', provider: 'anthropic', billing_source: 'host_managed', input_nano_usd_per_million: 10e9, output_nano_usd_per_million: 50e9 } ] },
    { model: { slug: 'byok-only' }, providers: [{ id: 'b', provider: 'openai', billing_source: 'customer_managed', input_nano_usd_per_million: 1e9 }] },
  ] },
  huggingface: { data: [{ id: 'Qwen/Qwen3.8-27B', owned_by: 'Qwen', providers: [
    { provider: 'novita', status: 'live', pricing: { input: 0.42, output: 3 } },
    { provider: 'featherless-ai', status: 'live' },
    { provider: 'deepinfra', status: 'live', pricing: { input: 0.2, output: 2.5 } } ] }] },
  openrouter: { data: [
    { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', hugging_face_id: 'Qwen/Qwen3.8-27B', pricing: { prompt: '0.0000004', completion: '0.000003', input_cache_read: '0.0000001' } },
    { id: 'openai/gpt-6', name: 'GPT-6', hugging_face_id: '', pricing: { prompt: '0.00001', completion: '0.00004' } },
    { id: 'x/free', pricing: { prompt: '0', completion: '0' } } ] },
};
const catalog = Object.entries(raw).flatMap(([source, body]) => normalizers[source](body));
const allSources = { catalog: { sources: ['experiential', 'huggingface', 'openrouter'] } };

test('normalizers keep priced platform lanes in serving order and mark open weights', () => {
  const kimi = catalog.find(m => m.slug === 'kimi-k3');
  assert.deepEqual(kimi.lanes.map(l => l.provider), ['experiential_cloud', 'wafer']);
  assert.deepEqual(kimi.lanes[0], { provider: 'experiential_cloud', input: 3, cached: 0.3, output: 15 });
  assert.equal(kimi.vendor, 'moonshot ai');
  assert.equal(catalog.some(m => m.slug === 'byok-only'), false);
  const hf = catalog.find(m => m.source === 'huggingface');
  assert.deepEqual(hf.lanes.map(l => [l.provider, l.cached]), [['novita', 0.42], ['deepinfra', 0.2]]);
  assert.equal(hf.openWeights, true);
  const or = catalog.filter(m => m.source === 'openrouter');
  assert.deepEqual(or.map(m => [m.slug, m.openWeights]), [['qwen/qwen3.8-27b', true], ['openai/gpt-6', false]]);
  assert.deepEqual(or[0].lanes[0], { provider: 'openrouter', input: 0.4, cached: 0.1, output: 3 });
});

test('report follows the shared economics for a hand-checked generic scenario', () => {
  const scenario = mergeScenario(defaults, { catalog: { include: [], exclude: [] },
    workload: { inputTpsPerGpu: 900, outputTpsPerGpu: 100, cacheHitRate: 0.5 },
    fleet: { gpuCount: 2, hoursPerMonth: 100, utilization: 0.5 },
    gpus: [{ id: 'g', name: 'G', hourlyRate: 2, throughput: 1 }] });
  const r = buildReport(catalog, scenario).models.find(m => m.id === 'experiential:kimi-k3').results[0];
  // blend = 0.9 x (0.5 x 3 + 0.5 x 0.3) + 0.1 x 15 = 2.985 $/M; 1000 tok/s x 2 GPUs x 100 h = 720 M tokens.
  assert.ok(Math.abs(r.blendedPrice - 2.985) < 1e-9);
  assert.ok(Math.abs(r.millionTokensAtFull - 720) < 1e-9);
  assert.equal(r.rent, 400);
  assert.ok(Math.abs(r.profit - (360 * 2.985 - 400)) < 1e-6);
  assert.ok(Math.abs(r.breakEvenUtilization - 400 / (720 * 2.985)) < 1e-12);
  assert.ok(Math.abs(r.breakEvenHourlyRate - 360 * 2.985 / 200) < 1e-9);
  assert.equal(r.lane, 'experiential_cloud');
});

test('lane choice, GPU map patches and per-model per-GPU overrides change the result', () => {
  const base = mergeScenario(defaults, allSources);
  const lead = buildReport(catalog, base).models.find(m => m.slug === 'kimi-k3');
  const cheap = buildReport(catalog, mergeScenario(base, { catalog: { lane: 'cheapest' } })).models.find(m => m.slug === 'kimi-k3');
  assert.equal(cheap.results[0].lane, 'wafer');
  assert.ok(cheap.results[0].blendedPrice < lead.results[0].blendedPrice);

  const patched = mergeScenario(base, { gpus: { h100: { hourlyRate: 1 }, tpu: { hourlyRate: 3, throughput: 0.9 }, mi300x: null } });
  assert.deepEqual(patched.gpus.map(g => g.id), ['h100', 'h200', 'b200', 'b300', 'mi355x', 'tpu']);
  assert.equal(patched.gpus[0].hourlyRate, 1);
  assert.equal(patched.gpus[0].throughput, defaults.gpus[0].throughput);

  const pinned = buildReport(catalog, mergeScenario(base, { models: { 'experiential:kimi-k3': { gpus: { b300: { inputTpsPerGpu: 6000, outputTpsPerGpu: 50 } }, output: 10 } } }))
    .models.find(m => m.slug === 'kimi-k3');
  const b300 = pinned.results.find(r => r.gpu === 'b300'), h100 = pinned.results.find(r => r.gpu === 'h100');
  assert.equal(b300.totalTps, 6050 * 8);
  assert.equal(h100.inputTpsPerGpu, defaults.workload.inputTpsPerGpu * defaults.gpus[0].throughput);
  assert.equal(b300.prices.output, 10);
});

test('source, pattern and open-weights filters decide which models are included', () => {
  const ids = s => buildReport(catalog, mergeScenario(defaults, s)).models.map(m => m.id);
  assert.deepEqual(ids({}), ['experiential:kimi-k3', 'huggingface:Qwen/Qwen3.8-27B']);
  assert.deepEqual(ids(allSources), ['experiential:kimi-k3', 'huggingface:Qwen/Qwen3.8-27B', 'openrouter:qwen/qwen3.8-27b']);
  assert.ok(ids({ ...allSources, catalog: { ...allSources.catalog, openWeightsOnly: false, exclude: [] } }).includes('openrouter:openai/gpt-6'));
  // Naming a model in overrides includes it even when a pattern excludes it.
  assert.ok(ids({ models: { 'claude-fable-5.1': {} } }).includes('experiential:claude-fable-5.1'));
});

test('curves sweep GPU price and utilization; CSV has one row per model and GPU', () => {
  const report = buildReport(catalog, mergeScenario(defaults, { sweep: { hourlyRate: { from: 1, to: 3, steps: 2 } } }), { curves: true });
  assert.deepEqual(report.axes.hourlyRate, [1, 2, 3]);
  const r = report.models[0].results[0];
  assert.equal(r.profitByHourlyRate.length, 3);
  assert.equal(r.profitByUtilization.length, defaults.sweep.utilization.steps + 1);
  assert.ok(r.profitByHourlyRate[0] > r.profitByHourlyRate[2]);
  const csv = reportToCsv(report).trim().split('\n');
  assert.equal(csv.length, 1 + report.models.length * defaults.gpus.length);
  assert.match(csv[0], /^source,slug,vendor,gpu/);
});

test('invalid scenarios fail with a named field', () => {
  const bad = [
    [{ fleet: { utilization: 2 } }, /fleet.utilization/],
    [{ catalog: { lane: 'random' } }, /catalog.lane/],
    [{ catalog: { sources: ['elsewhere'] } }, /catalog.sources/],
    [{ gpus: { h100: { hourlyRate: -1 } } }, /gpus.h100.hourlyRate/],
    [{ gpus: [] }, /gpus must list/],
    [{ sweep: { hourlyRate: { from: 5, to: 1, steps: 4 } } }, /sweep.hourlyRate/],
    [{ models: { x: { gpus: { b300: { cacheHitRate: 3 } } } } }, /models.x.gpus.b300.cacheHitRate/],
  ];
  for (const [patch, message] of bad) assert.throws(() => buildReport(catalog, mergeScenario(defaults, patch)), e => e instanceof ScenarioError && message.test(e.message));
});

const fakeLoader = async sources => ({ status: Object.fromEntries(sources.map(s => [s, { ok: true }])), models: catalog });
const serve = createHandler({ catalogLoader: fakeLoader });
const call = async (path, { method = 'GET', body } = {}) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await serve({ url: path, method, headers: {}, body }, res);
  return res;
};

test('report API accepts a POSTed or query-string scenario and serves JSON or CSV', async () => {
  const post = await call('/api/report', { method: 'POST', body: JSON.stringify({ gpus: { h100: { hourlyRate: 1.25 } } }) });
  assert.equal(post.statusCode, 200);
  const json = JSON.parse(post.body);
  assert.equal(json.scenario.gpus[0].hourlyRate, 1.25);
  assert.equal(json.models[0].results[0].profitByHourlyRate, undefined);
  const curves = JSON.parse((await call('/api/report?curves=1', { method: 'POST', body: '{}' })).body);
  assert.ok(Array.isArray(curves.models[0].results[0].profitByHourlyRate));
  const query = await call('/api/report?format=csv&scenario=' + encodeURIComponent(JSON.stringify({ fleet: { gpuCount: 4 } })));
  assert.match(query.headers['content-type'], /^text\/csv/);
  assert.match(query.body.split('\n')[1], /,h100,4,/);
});

test('report API answers 400 for bad input and 405 for other methods', async () => {
  for (const body of ['not json', JSON.stringify({ fleet: { utilization: -1 } })]) {
    const res = await call('/api/report', { method: 'POST', body });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error);
  }
  const put = await call('/api/report', { method: 'PUT' });
  assert.equal(put.statusCode, 405);
  assert.equal(put.headers.allow, 'GET, HEAD, POST');
  assert.equal((await call('/api/catalog?sources=elsewhere')).statusCode, 400);
  assert.deepEqual(JSON.parse((await call('/api/scenario')).body), defaults);
});

test('catalog loader fetches only fixed URLs and reports a failed source without failing the rest', async () => {
  clearCatalogCache();
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    if (url === SOURCE_URLS.openrouter) return { ok: false, status: 503 };
    const source = Object.keys(SOURCE_URLS).find(s => SOURCE_URLS[s] === url);
    return { ok: true, json: async () => raw[source] };
  };
  const result = await loadCatalog(['experiential', 'huggingface', 'openrouter'], fetchImpl);
  assert.deepEqual(seen.sort(), Object.values(SOURCE_URLS).sort());
  assert.equal(result.status.experiential.models, 2);
  assert.equal(result.status.openrouter.ok, false);
  assert.equal(result.models.length, 3);
  await loadCatalog(['experiential'], fetchImpl);
  assert.equal(seen.length, 3, 'second load is served from the cache');
  clearCatalogCache();
});

test('heatmap model endpoint shapes one catalog model on one GPU like a benchmark entry', async () => {
  const patch = { gpus: { b300: { hourlyRate: 4 } }, models: { 'kimi-k3': { output: 9 } } };
  const res = await call('/api/heatmap-model?' + new URLSearchParams({ id: 'experiential:kimi-k3', gpu: 'b300', scenario: JSON.stringify(patch) }));
  assert.equal(res.statusCode, 200);
  const { model } = JSON.parse(res.body);
  assert.equal(model.hardware, 'B300');
  assert.equal(model.defaultHourlyRate, 4);
  assert.equal(model.defaultGpuCount, defaults.fleet.gpuCount);
  assert.equal(model.inputTpsPerGpu, defaults.workload.inputTpsPerGpu * 1.0);
  assert.equal(model.capacityKind, 'generic');
  assert.deepEqual(model.prices.map(p => p.name), ['Scenario price', 'experiential · experiential_cloud', 'experiential · wafer']);
  assert.equal(model.prices[0].output, 9);
  assert.equal(model.prices[0].input, 3);
  // Every field the original heatmap reads is present.
  for (const key of ['id', 'name', 'engine', 'workload', 'cacheHitRate', 'outputTpsPerGpu', 'defaultHoursPerMonth', 'assumptions', 'sourceLinks', 'pricesAsOf']) assert.ok(model[key] !== undefined, key);
  const plain = await call('/api/heatmap-model?id=experiential:kimi-k3&gpu=h100');
  assert.equal(plain.statusCode, 200, 'a model with no override in the scenario');
  assert.deepEqual(JSON.parse(plain.body).model.prices.map(p => p.name), ['experiential · experiential_cloud', 'experiential · wafer']);
  const pinned = JSON.parse((await call('/api/heatmap-model?' + new URLSearchParams({ id: 'experiential:kimi-k3', gpu: 'b300',
    scenario: JSON.stringify({ models: { 'kimi-k3': { gpus: { b300: { inputTpsPerGpu: 6000, outputTpsPerGpu: 50 } } } } }) }))).body).model;
  assert.equal(pinned.capacityKind, 'measured');
  assert.equal(pinned.outputTpsPerGpu, 50);
  for (const query of ['id=nope:x&gpu=b300', 'id=experiential:missing&gpu=b300', 'id=experiential:kimi-k3&gpu=tpu', 'id=experiential:kimi-k3&gpu=b300&scenario=%7B']) {
    assert.equal((await call('/api/heatmap-model?' + query)).statusCode, 400, query);
  }
});
