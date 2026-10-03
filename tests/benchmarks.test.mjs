import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../lib/agentx-snapshot.json' with { type: 'json' };
import { models, curveKey, selectPoint, cacheShare, physicalGpuCount } from '../lib/benchmarks.mjs';
import { rentalRates, unavailableAccelerators } from '../lib/rental-rates.mjs';
import { economics, profitAt } from '../private/economics.mjs';

const rows = snapshot.sources.flatMap(source => source.rows);
const scenario = m => ({ ...m, gpus: m.defaultGpuCount, hourlyRate: m.defaultHourlyRate, hours: 730,
  utilization: 1, otherMonthlyCost: 0, feeRate: 0, inputPrice: 0, cachedPrice: 0, outputPrice: 0 });

test('latest registry exposes all non-retired AgentX curves and no fixed-sequence substitutes', () => {
  assert.equal(rows.length, 948);
  assert.equal(models.length, 73);
  assert.equal(new Set(models.map(m => m.modelKey)).size, 8);
  assert.equal(new Set(models.map(m => m.hardwareKey)).size, 10);
  assert.equal(new Set(models.map(m => m.id)).size, models.length);
  assert.equal(new Set(rows.filter(row => row.model !== 'glm5.2').map(curveKey)).size, models.length);
  assert(rows.every(row => row.benchmark_type === 'agentic_traces'));
  assert(models.some(m => m.modelKey === 'glm5.3' && m.benchmarkModel === 'glm5.3' && !m.estimateFrom));
});

test('GLM-5.2 is removed and GLM-5.3 has a plain name backed by its own measurements', () => {
  assert(!models.some(m => m.modelKey === 'glm5.2' || /GLM-5\.2/.test(m.name)));
  const glm53 = models.filter(m => m.modelKey === 'glm5.3');
  assert(glm53.length > 0);
  for (const model of glm53) {
    assert.equal(model.name, 'GLM-5.3');
    assert.equal(model.capacityKind, 'measured');
    assert.equal(model.benchmarkModel, 'glm5.3');
    assert.equal(model.estimateFrom, undefined);
  }
});

test('every chart point reproduces its source throughput, cache share, and physical GPU count', () => {
  for (const m of models) {
    const row = rows.find(row => String(row.id) === m.benchmarkIds[0]);
    assert(row, m.id);
    assert.equal(row.model, m.modelKey);
    assert.equal(row.hardware, m.hardwareKey);
    assert(Math.abs((m.inputTpsPerGpu + m.outputTpsPerGpu) / row.metrics.tput_per_gpu - 1) < 1e-12);
    assert.equal(m.cacheHitRate, cacheShare(row).value);
    assert.equal(m.measuredGpuCount, physicalGpuCount(row));
    assert(m.defaultGpuCount >= m.measuredGpuCount);
    assert.equal(m.defaultGpuCount, m.measuredGpuCount * m.replicas);
    assert.equal(m.targetMet, row.metrics.p90_intvty >= 50);
    const curve = rows.filter(other => curveKey(other) === curveKey(row));
    assert.equal(String(selectPoint(curve).id), m.benchmarkIds[0]);
    const e = economics(scenario(m));
    assert(Number.isFinite(e.breakEvenPrice) && e.breakEvenPrice > 0);
    assert(Math.abs(profitAt(scenario(m), 1, e.breakEvenPrice)) < .0001);
  }
});

test('below-target curves and unknown market-price mixes are explicitly labeled', () => {
  const slow = models.filter(m => !m.targetMet);
  assert.equal(slow.length, 6);
  for (const m of slow) {
    assert.match(m.setupLabel, /below speed target/);
    assert.match(m.assumptions, /No published point/);
  }
  for (const m of models.filter(m => m.cacheHitRate === null || !m.inputShareKnown)) {
    assert.equal(m.prices.length, 0);
    assert.match(m.assumptions, /reference lines are omitted/);
  }
});

test('cache accounting never double-counts external and CPU hits or treats absent data as zero', () => {
  const row = metrics => ({ hardware: 'b300', metrics });
  assert(Math.abs(cacheShare(row({ server_gpu_cache_hit_rate: .2, server_cpu_cache_hit_rate: .3, server_external_cache_hit_rate: .4 })).value - .6) < 1e-12);
  assert.equal(cacheShare(row({ server_gpu_cache_hit_rate: .2, server_cpu_cache_hit_rate: .3, server_external_cache_hit_rate: 0 })).value, .2);
  assert.equal(cacheShare(row({ server_gpu_cache_hit_rate: .2, server_cpu_cache_hit_rate: .3 })).value, .5);
  assert.equal(cacheShare(row({})).value, null);
  assert.equal(cacheShare(row({ theoretical_cache_hit_rate: .9 })).value, null);
  assert.equal(cacheShare({ hardware: 'gb300', metrics: { theoretical_cache_hit_rate: .9 } }).value, .9);
  assert.equal(physicalGpuCount({ disagg: false, num_prefill_gpu: 8, num_decode_gpu: 8 }), 8);
  assert.equal(physicalGpuCount({ disagg: true, num_prefill_gpu: 8, num_decode_gpu: 32 }), 40);
});

test('B300 uses the agreed rate; other hardware uses cited defaults with estimated rates labeled', () => {
  assert.equal(rentalRates.b300.rate, 5.5);
  assert.equal(rentalRates.b200.rate, 6.69);
  assert.equal(rentalRates.h100.rate, 3.99);
  assert.equal(rentalRates.vr200.kind, 'estimate');
  for (const m of models) {
    assert.deepEqual(m.rental, rentalRates[m.hardwareKey]);
    assert.equal(m.defaultHourlyRate, m.rental.rate);
    if (m.hardwareKey !== 'b300') assert.match(m.rental.source, /^https:\/\//);
    const s = scenario(m);
    for (const rate of [0, 5.5, 25]) {
      const changed = { ...s, hourlyRate: rate };
      assert.equal(economics(changed).rent, m.defaultGpuCount * rate * 730);
      assert.equal(economics(changed).millionTokensAtFull, economics(s).millionTokensAtFull);
      assert(Math.abs(profitAt(changed, .6, .1) - profitAt(s, .6, .1) + (rate - s.hourlyRate) * s.gpus * 730) < .0001);
    }
  }
});

test('TPU entries are price-only without invented benchmark or profitability data', () => {
  assert.equal(unavailableAccelerators.length, 2);
  assert.deepEqual(unavailableAccelerators.map(t => t.hourlyRate), [12, 2.7]);
  for (const t of unavailableAccelerators) {
    assert.equal(t.unit, 'chip');
    assert.match(t.reason, /No AgentX benchmark/);
    assert(!models.some(m => m.hardwareKey === t.id));
    assert.equal(t.inputTpsPerGpu, undefined);
  }
});
