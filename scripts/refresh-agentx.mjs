// Public, read-only source refresh. Generated data stays separate from UI code.
import { writeFile } from 'node:fs/promises';

const base = 'https://inferencex.semianalysis.com';
async function get(path) {
  const url = `${base}${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const [options, availability] = await Promise.all([get('/api/v1/views/options'), get('/api/v1/availability')]);
const dbModels = new Set(availability.filter(row => row.benchmark_type === 'agentic_traces').map(row => row.model));
const displayModels = options.models.filter(model => model.dbKeys.some(key => dbModels.has(key)));
const sources = [];
for (const model of displayModels) {
  const path = `/api/v1/benchmarks?${new URLSearchParams({ model: model.name, view: 'calculator', sequence: 'agentic-traces' })}`;
  const rows = (await get(path)).filter(row => row.benchmark_type === 'agentic_traces');
  sources.push({ model: model.name, url: base + path, rows });
  console.log(`${model.name}: ${rows.length} latest AgentX points`);
}
const snapshot = {
  fetchedAt: new Date().toISOString(),
  methodology: `${base}/agentx`,
  selection: 'Latest published AgentX snapshots, not fixed-sequence benchmarks or a complete historical archive.',
  hardware: options.hardware,
  frameworks: options.frameworks,
  sources,
};
await writeFile(new URL('../lib/agentx-snapshot.json', import.meta.url), JSON.stringify(snapshot));
console.log(`Saved ${sources.reduce((n, source) => n + source.rows.length, 0)} source points.`);
