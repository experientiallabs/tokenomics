// CLI: node report.mjs [scenario.json ...] [--csv] [--curves]
// Each scenario file is a partial override deep-merged over private/default-scenario.json, in order.
import { readFileSync } from 'node:fs';
import { loadCatalog } from './lib/catalog.mjs';
import { buildReport, mergeScenario, reportToCsv } from './private/tokenomics.mjs';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
let scenario = JSON.parse(readFileSync(new URL('./private/default-scenario.json', import.meta.url), 'utf8'));
for (const file of files) scenario = mergeScenario(scenario, JSON.parse(readFileSync(file, 'utf8')));
const catalog = await loadCatalog(scenario.catalog.sources);
const report = { generatedAt: new Date().toISOString(), sources: catalog.status,
  ...buildReport(catalog.models, scenario, { curves: args.includes('--curves') }) };
process.stdout.write(args.includes('--csv') ? reportToCsv(report) : JSON.stringify(report, null, 2) + '\n');
