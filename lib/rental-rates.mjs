// USD per physical GPU-hour. List prices, not a market average or capacity guarantee.
const checkedAt = '2026-10-03';
const listed = (rate, provider, terms, source, note = '') => ({ rate, provider, terms, source, note, checkedAt, kind: 'published' });
export const rentalRates = {
  b300: { rate: 5.5, provider: 'Your B300 rate', terms: 'User-provided assumption', kind: 'user', checkedAt },
  b200: listed(6.69, 'Lambda', '8-GPU instance, on-demand', 'https://lambda.ai/pricing'),
  h100: listed(3.99, 'Lambda', '8-GPU SXM instance, on-demand', 'https://lambda.ai/pricing'),
  h200: listed(5.99, 'Together AI', 'GPU cluster, on-demand', 'https://www.together.ai/pricing'),
  gb200: listed(10.5, 'CoreWeave', 'North America, on-demand', 'https://www.coreweave.com/pricing', '$42/hour for a four-GPU instance, divided by four.'),
  gb300: listed(18, 'Oracle Cloud', 'Bare metal, pay as you go', 'https://www.oracle.com/cloud/price-list/', 'SKU B112140; USD price verified against Oracle’s public cloud-price-list.json feed.'),
  mi300x: listed(3.39, 'Hot Aisle', '8-GPU bare-metal node', 'https://hotaisle.xyz/pricing'),
  mi325x: listed(4.62, 'Vultr', 'Published non-preemptible list rate', 'https://api.vultr.com/v2/plans-metal', '$36.92/hour ÷ 8 GPUs, rounded to cents. The feed currently lists no on-demand locations; this is a price reference, not available capacity.'),
  mi355x: listed(8.6, 'Oracle Cloud', 'Bare metal, pay as you go', 'https://www.oracle.com/cloud/price-list/', 'SKU B111758. Vultr also lists a lower $2.59/GPU-hour plan, but currently enables only preemptible deployment; it is not used as the baseline.'),
  vr200: { rate: 8.5, provider: 'SemiAnalysis', terms: 'Rental estimate, not a verified market quote', source: 'https://inferencex.semianalysis.com/api/v1/views/options', checkedAt, kind: 'estimate' },
};

// Price-only entries: deliberately no throughput, capacity, or profitability values.
export const unavailableAccelerators = [
  { id: 'tpu7x', name: 'TPU Ironwood', hourlyRate: 12, unit: 'chip', region: 'us-central1' },
  { id: 'tpu6e', name: 'TPU Trillium', hourlyRate: 2.7, unit: 'chip', region: 'us-east1' },
].map(item => ({ ...item, reason: 'No AgentX benchmark', source: 'https://cloud.google.com/tpu/pricing', terms: 'Google Cloud on-demand', checkedAt }));
