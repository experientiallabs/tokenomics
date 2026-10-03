import snapshot from './agentx-snapshot.json' with { type: 'json' };
import { models as previousModels } from './models.mjs';
import { rentalRates } from './rental-rates.mjs';

export const TARGET_TPS = 50;
const names = {
  dsv41flash: 'DeepSeek V4.1 Flash', dsv4: 'DeepSeek V4 Pro',
  'glm5.2': 'GLM-5.2', 'glm5.3': 'GLM-5.3', kimik3: 'Kimi K3',
  minimaxm3: 'MiniMax M3', 'qwen3.5': 'Qwen 3.5 397B',
  'qwen3.8next': 'Qwen 3.8 Flash Next', 'glm5.1': 'GLM-5.1',
};
const modelOrder = Object.keys(names);
const gpuOrder = ['b300', 'b200', 'h200', 'h100', 'mi355x', 'mi325x', 'mi300x', 'gb300', 'gb200', 'vr200'];
const previousIds = {
  dsv41flash: 'deepseek-v41-flash-b300', dsv4: 'deepseek-v4-pro-b300',
  'glm5.2': 'glm-52-b300', 'glm5.3': 'glm-53-proxy-b300', kimik3: 'kimi-k3-b300',
};
const additionalPrices = {
  minimaxm3: [{ id: 'gmicloud', name: 'OpenRouter · GMICloud', input: .24, cached: .048, output: .96, source: 'https://openrouter.ai/minimax/minimax-m3/providers' }],
  'qwen3.5': [{ id: 'deepinfra', name: 'OpenRouter · DeepInfra', input: .45, cached: .22, output: 3, source: 'https://openrouter.ai/qwen/qwen3.5-397b-a17b/providers' }],
};

// Match SemiAnalysis cache-pricing.ts: external already includes CPU/offload.
// A missing measurement is NOT zero. Only GB300 has their documented fallback.
export function cacheShare(row) {
  const m = row.metrics, finite = value => typeof value === 'number' && Number.isFinite(value);
  const secondary = finite(m.server_external_cache_hit_rate) ? m.server_external_cache_hit_rate : m.server_cpu_cache_hit_rate;
  if (finite(m.server_gpu_cache_hit_rate) || finite(secondary)) {
    return { value: Math.max(0, Math.min(1, (finite(m.server_gpu_cache_hit_rate) ? m.server_gpu_cache_hit_rate : 0) + (finite(secondary) ? secondary : 0))), kind: 'measured' };
  }
  if (row.hardware === 'gb300' && finite(m.theoretical_cache_hit_rate)) {
    return { value: Math.max(0, Math.min(1, m.theoretical_cache_hit_rate)), kind: 'trace estimate' };
  }
  return { value: null, kind: 'unavailable' };
}

export const physicalGpuCount = row => row.disagg ? row.num_prefill_gpu + row.num_decode_gpu : row.num_decode_gpu;
export const curveKey = row => [row.model, row.hardware, row.framework, row.precision].join('|');
const totalTps = row => row.metrics.tput_per_gpu;

export function selectPoint(rows) {
  const valid = rows.filter(row => Number.isFinite(totalTps(row)) && totalTps(row) > 0
    && Number.isFinite(row.metrics.p90_intvty) && row.metrics.p90_intvty > 0
    && Number.isInteger(physicalGpuCount(row)) && physicalGpuCount(row) > 0);
  const qualified = valid.filter(row => row.metrics.p90_intvty >= TARGET_TPS);
  return (qualified.length ? qualified : valid).toSorted((a, b) => totalTps(b) - totalTps(a) || String(b.id).localeCompare(String(a.id)))[0];
}

export function buildBenchmarks(data) {
  const hardware = new Map(data.hardware.map(h => [h.key, h.label]));
  const frameworks = new Map(data.frameworks.map(f => [f.key, f.label.replace('¹', '')]));
  const groups = new Map();
  for (const source of data.sources) for (const row of source.rows) {
    if (row.benchmark_type !== 'agentic_traces') continue;
    const key = curveKey(row);
    if (!groups.has(key)) groups.set(key, { source, rows: [] });
    groups.get(key).rows.push(row);
  }
  const result = [];
  for (const [key, { source, rows }] of groups) {
    const row = selectPoint(rows);
    if (!row) throw new Error(`No usable throughput for ${key}`);
    const m = row.metrics, measuredGpuCount = physicalGpuCount(row);
    const rental = rentalRates[row.hardware];
    if (!rental) throw new Error(`No sourced rental default for ${row.hardware}`);
    // Replicate complete independent serving units, never shrink a multinode run.
    const defaultGpuCount = measuredGpuCount <= 8 && 8 % measuredGpuCount === 0 ? 8 : measuredGpuCount;
    const replicas = defaultGpuCount / measuredGpuCount;
    const cache = cacheShare(row);
    const sum = m.input_tput_per_gpu + m.output_tput_per_gpu;
    const compatibleRates = Number.isFinite(sum) && sum > 0 && Math.abs(sum / totalTps(row) - 1) <= .01;
    const prompt = m.total_prompt_tokens, output = m.total_generation_tokens;
    const inputShare = compatibleRates ? m.input_tput_per_gpu / sum
      : Number.isFinite(prompt) && Number.isFinite(output) && prompt + output > 0 ? prompt / (prompt + output) : null;
    const previous = previousModels.find(model => model.id === previousIds[row.model]);
    const prices = inputShare !== null && cache.value !== null ? previous?.prices || additionalPrices[row.model] || [] : [];
    const targetMet = m.p90_intvty >= TARGET_TPS;
    const setupLabel = `${frameworks.get(row.framework) || row.framework} · ${row.precision.toUpperCase()}`;
    const units = replicas > 1 ? `${replicas} × ${measuredGpuCount}-GPU replicas` : `${defaultGpuCount} GPUs`;
    result.push({
      id: `agentx-${key.replaceAll('|', '-')}`, modelKey: row.model, name: names[row.model] || row.model,
      hardwareKey: row.hardware, hardware: hardware.get(row.hardware) || row.hardware,
      engine: setupLabel, setupLabel: `${setupLabel} · ${units}${targetMet ? '' : ' · below speed target'}`,
      workload: 'AgentX agentic coding', capacityKind: 'measured', benchmarkModel: row.model,
      inputTpsPerGpu: totalTps(row) * (inputShare ?? 1), outputTpsPerGpu: totalTps(row) * (inputShare === null ? 0 : 1 - inputShare),
      inputShareKnown: inputShare !== null, cacheHitRate: cache.value, cacheKind: cache.kind,
      interactivity: TARGET_TPS, measuredInteractivity: m.p90_intvty, targetMet,
      firstTokenSeconds: m.p90_ttft ?? null, concurrency: row.conc,
      defaultGpuCount, measuredGpuCount, replicas, rental, defaultHourlyRate: rental.rate, defaultHoursPerMonth: 730,
      measuredAt: row.date, snapshotAt: data.fetchedAt.slice(0, 10), benchmarkIds: [String(row.id)], sourcePointCount: rows.length,
      source: `https://inferencex.semianalysis.com/inference/agentic/${row.id}`,
      sourceApi: source.url, methodology: data.methodology, runUrl: row.run_url,
      prices, pricesAsOf: previous?.pricesAsOf || (prices.length ? '2026-10-03' : null),
      assumptions: [
        targetMet ? `Highest measured total throughput at or above ${TARGET_TPS} output tokens/sec/user (p90) in this serving curve. No interpolation.`
          : `No published point in this curve meets ${TARGET_TPS} output tokens/sec/user (p90). Showing the highest-throughput measured point at ${m.p90_intvty.toFixed(1)} tokens/sec/user; do not compare it as equivalent service quality.`,
        replicas > 1 ? `The ${defaultGpuCount}-GPU scenario assumes ${replicas} independent replicas of the measured ${measuredGpuCount}-GPU setup, with linear replication. It is not a measured ${defaultGpuCount}-GPU run.`
          : `Uses the measured ${measuredGpuCount}-GPU configuration${row.disagg ? ` (${row.num_prefill_gpu} prefill + ${row.num_decode_gpu} decode)` : ''}, not a normalized 8-GPU estimate.`,
        `Measured load: ${row.conc} concurrent sessions. ${m.p90_ttft == null ? 'First-token latency unavailable.' : `p90 first-token wait: ${m.p90_ttft.toFixed(2)} seconds.`} No first-token latency limit is imposed.`,
        cache.kind === 'trace estimate' ? 'Cache share uses the trace-based GB300 estimate, following the SemiAnalysis calculator, because a server measurement is unavailable.' : '',
        cache.value === null || inputShare === null ? 'Cache share or input/output mix is unavailable, so market-price reference lines are omitted. The total-token price axis and GPU rental economics still use measured total throughput.' : '',
        !prices.length && cache.value !== null && inputShare !== null ? 'No verified market-price reference is attached to this exact model; use the blended-price axis.' : '',
        'Published rental defaults are list-price references, not negotiated quotes or guaranteed capacity. Total throughput includes cached input. Measured benchmark capacity is not measured customer demand.',
      ].filter(Boolean).join(' '),
    });
  }
  return result.sort((a, b) => modelOrder.indexOf(a.modelKey) - modelOrder.indexOf(b.modelKey)
    || gpuOrder.indexOf(a.hardwareKey) - gpuOrder.indexOf(b.hardwareKey)
    || Number(b.targetMet) - Number(a.targetMet)
    || (b.inputTpsPerGpu + b.outputTpsPerGpu) - (a.inputTpsPerGpu + a.outputTpsPerGpu));
}

export const models = buildBenchmarks(snapshot);
