import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../api/index.mjs';
import { models as measuredModels } from '../lib/benchmarks.mjs';
import { loadEstimates, runReport } from '../lib/estimates.mjs';
import { ANCHOR_SLUGS, estimable, estimateEntry, fitEstimator } from '../private/estimate.mjs';
import { buildReport, mergeScenario, normalizers, reportToCsv, ScenarioError, validateScenario } from '../private/tokenomics.mjs';

const defaults = JSON.parse(readFileSync(new URL('../private/default-scenario.json', import.meta.url), 'utf8'));
const lane = (input, output, cached = input / 10) => ({ provider: 'p', input, cached, output });
const rental = rate => ({ rate, provider: 'Test', terms: 'test', kind: 'published', checkedAt: '2026-10-05' });
// Two GPUs; on each, throughput is exactly 1e6 / (input + output price), so the fitted slope is -1.
const point = (modelKey, hardwareKey, price, speed) => ({ modelKey, name: modelKey, hardwareKey, hardware: hardwareKey.toUpperCase(),
  inputTpsPerGpu: speed * 0.99 / price, outputTpsPerGpu: speed * 0.01 / price, cacheHitRate: 0.9, inputShareKnown: true,
  targetMet: true, rental: rental(hardwareKey === 'b300' ? 5 : 2) });
const measured = [point('dsv41flash', 'b300', 1, 1e6), point('kimik3', 'b300', 10, 1e6), point('minimaxm3', 'b300', 2, 1e6),
  point('dsv41flash', 'h100', 1, 1e5), point('minimaxm3', 'h100', 2, 1e5)];
const catalog = [
  { source: 'experiential', slug: 'deepseek-v4.1-flash', name: 'Flash', lanes: [lane(0.5, 0.5)] },
  { source: 'experiential', slug: 'kimi-k3', name: 'Kimi', lanes: [lane(5, 5)] },
  { source: 'experiential', slug: 'minimax-m3', name: 'MiniMax', lanes: [lane(1, 1)] },
  { source: 'experiential', slug: 'new-model', name: 'New', lanes: [lane(2, 2), lane(1, 1)] },
  { source: 'experiential', slug: 'embed', name: 'Embed', lanes: [lane(0.1, 0)] },
  { source: 'experiential', slug: 'image', name: 'Image', textOutput: false, lanes: [lane(1, 1)] },
];

test('fit recovers the price relationship and per-GPU levels', () => {
  const fit = fitEstimator(measured, catalog);
  assert.ok(Math.abs(fit.slope + 1) < 1e-9);
  assert.ok(Math.abs(fit.typicalErrorFactor - 1) < 1e-9);
  assert.equal(fit.points, 5);
  assert.deepEqual(Object.keys(fit.gpus).sort(), ['b300', 'h100']);
  assert.ok(Math.abs(Math.exp(fit.gpus.b300.level) - 1e6) < 1e-3);
  assert.ok(Math.abs(fit.gpus.h100.inputShare - 0.99) < 1e-12);
  assert.deepEqual(fit.priceRange.map(v => +v.toFixed(9)), [1, 10]);
});

test('estimates follow the fit; measured models scale their own speed to unmeasured GPUs', () => {
  const fit = fitEstimator(measured, catalog);
  const e = estimateEntry(fit, catalog[3], 'b300', '2026-10-05');
  assert.ok(Math.abs(e.inputTpsPerGpu + e.outputTpsPerGpu - 1e6 / 4) < 1e-6);
  assert.equal(e.capacityKind, 'estimate');
  assert.equal(e.defaultHourlyRate, 5);
  assert.deepEqual(e.prices.map(p => p.input), [2, 1]);
  // Cheapest is judged by blended price: a lower list price with no cache discount loses.
  const noCacheDiscount = estimateEntry(fit, { slug: 'n', name: 'N', lanes: [lane(2, 2, 0.1), lane(1, 1, 1)] }, 'b300');
  assert.equal(noCacheDiscount.prices.length, 1);
  assert.match(e.assumptions, /Estimate, not a measurement/);
  // Kimi is only measured on B300; on H100 it keeps its B300 speed relative to the GPU level.
  const kimi = estimateEntry(fit, catalog[1], 'h100');
  assert.ok(Math.abs(kimi.inputTpsPerGpu + kimi.outputTpsPerGpu - 1e5 / 10) < 1e-6);
  assert.match(kimi.setupLabel, /scaled from kimik3/);
  assert.equal(estimateEntry(fit, catalog[3], 'mi300x'), null);
  assert.equal(estimateEntry(fit, catalog[4], 'b300'), null, 'embedding');
  assert.equal(estimateEntry(fit, catalog[5], 'b300'), null, 'non-text output');
  assert.match(estimateEntry(fit, { slug: 'x', name: 'X', lanes: [lane(50, 50)] }, 'b300').assumptions, /extrapolates/);
});

test('the shipped AgentX snapshot fits with a falling price slope and every anchor slug exists', () => {
  const live = Object.values(ANCHOR_SLUGS).map(slug => ({ source: 'experiential', slug, name: slug, lanes: [lane(1, 4)] }));
  const fit = fitEstimator(measuredModels, live);
  assert.ok(fit.points >= 20);
  assert.ok(Object.keys(fit.gpus).includes('b300'));
});

test('report uses measurements where they exist, estimates elsewhere, and scenario pins on top', () => {
  const fit = fitEstimator(measured, catalog);
  const run = patch => buildFrom(fit, patch);
  const flash = run({}).models.find(m => m.slug === 'deepseek-v4.1-flash');
  assert.deepEqual(flash.results.map(r => [r.gpu, r.kind]), [['b300', 'measured'], ['h100', 'measured']]);
  const kimi = run({}).models.find(m => m.slug === 'kimi-k3');
  assert.deepEqual(kimi.results.map(r => [r.gpu, r.kind]), [['b300', 'measured'], ['h100', 'estimate']]);
  assert.equal(run({}).models.some(m => m.slug === 'embed'), false);
  const pinned = run({ gpus: { h100: { hourlyRate: 1 } }, models: { 'new-model': { output: 9, gpus: { h100: { inputTpsPerGpu: 1000, outputTpsPerGpu: 10 } } } } })
    .models.find(m => m.slug === 'new-model').results;
  assert.deepEqual(pinned.map(r => r.gpu), ['h100']);
  assert.equal(pinned[0].kind, 'pinned');
  assert.equal(pinned[0].totalTps, 1010 * 8);
  assert.equal(pinned[0].hourlyRate, 1);
  assert.equal(pinned[0].prices.output, 9);
  const csv = reportToCsv(run({})).trim().split('\n');
  assert.match(csv[0], /^source,slug,vendor,gpu,kind,/);
});

const buildFrom = (fit, patch) => buildReport(catalog, measured, fit, mergeScenario(defaults, patch));

test('invalid scenarios fail with a named field', () => {
  const keys = ['b300', 'h100'];
  for (const [patch, message] of [[{ fleet: { utilization: 2 } }, /fleet.utilization/], [{ gpus: { tpu: {} } }, /gpus.tpu/],
    [{ catalog: { sources: ['x'] } }, /catalog.sources/], [{ models: { a: { gpus: { b300: { cacheHitRate: 3 } } } } }, /models.a.gpus.b300.cacheHitRate/],
    [{ sweep: { hourlyRate: { from: 5, to: 1, steps: 2 } } }, /sweep.hourlyRate/]]) {
    assert.throws(() => validateScenario(mergeScenario(defaults, patch), keys), e => e instanceof ScenarioError && message.test(e.message));
  }
  // Chained scenarios merge per-model GPU pins; null deletes.
  const chained = mergeScenario(mergeScenario(defaults, { models: { a: { gpus: { b300: { inputTpsPerGpu: 1 } } } } }), { models: { a: { gpus: { b300: { outputTpsPerGpu: 2 }, h100: null } } } });
  assert.deepEqual(chained.models.a.gpus, { b300: { inputTpsPerGpu: 1, outputTpsPerGpu: 2 } });
});

const raw = { models: catalog.map(c => ({ model: { slug: c.slug, display_name: c.name, output_modalities: c.textOutput === false ? ['image'] : ['text'] },
  default_provider_ids: c.lanes.map((_, i) => `${c.slug}-${i}`),
  providers: c.lanes.map((l, i) => ({ id: `${c.slug}-${i}`, provider: 'p', billing_source: 'host_managed', input_nano_usd_per_million: l.input * 1e9,
    cached_input_nano_usd_per_million: l.cached * 1e9, output_nano_usd_per_million: l.output * 1e9 })) })) };
const loader = async sources => {
  return { status: Object.fromEntries(sources.map(s => [s, { ok: true, models: 1, fetchedAt: '2026-10-05T00:00:00Z' }])),
    models: sources.includes('experiential') ? normalizers.experiential(raw) : [] };
};

test('estimates endpoint serves the live fit and only estimable catalog models', async () => {
  const data = await loadEstimates(loader);
  assert.deepEqual(data.catalog.map(c => c.slug).sort(), ['deepseek-v4.1-flash', 'kimi-k3', 'minimax-m3', 'new-model']);
  assert.ok(data.fit.points >= 2);
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await createHandler({ catalogLoader: loader })({ url: '/api/estimates', method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).catalog, data.catalog);
  const failing = async sources => ({ status: Object.fromEntries(sources.map(s => [s, { ok: false }])), models: [] });
  await assert.rejects(loadEstimates(failing), /unavailable/);
});

test('report API and CLI path return JSON or CSV over the real AgentX snapshot', async () => {
  const report = await runReport(mergeScenario(defaults, { gpus: { b300: { hourlyRate: 4 } } }), { catalogLoader: loader });
  assert.ok(report.models.length >= 3);
  assert.ok(report.models.every(m => m.results.every(r => r.gpu === 'b300' && r.hourlyRate === 4)));
  const call = async (url, method = 'GET', body) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
    await createHandler({ catalogLoader: loader })({ url, method, headers: {}, body }, res);
    return res;
  };
  const csv = await call('/api/report?format=csv', 'POST', JSON.stringify({ gpus: { h100: {} } }));
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body.split('\n')[1], /,h100,(measured|estimate),/);
  assert.equal((await call('/api/report', 'POST', '{"gpus":{"tpu":{}}}')).statusCode, 400);
  assert.equal((await call('/api/report', 'POST', 'nope')).statusCode, 400);
  assert.equal((await call('/api/heatmap-model')).statusCode, 404);
  assert.equal((await call('/explorer')).statusCode, 404);
});

test('every estimable catalog model gets an estimate on every fitted GPU', () => {
  const fit = fitEstimator(measured, catalog);
  for (const model of catalog.filter(estimable)) for (const gpu of Object.keys(fit.gpus)) {
    const e = estimateEntry(fit, model, gpu);
    assert.ok(e && Number.isFinite(e.inputTpsPerGpu) && e.inputTpsPerGpu > 0, `${model.slug} ${gpu}`);
  }
});
