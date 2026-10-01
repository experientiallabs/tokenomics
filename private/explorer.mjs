import { buildReport, mergeScenario, reportToCsv } from '/tokenomics.mjs';

const $ = id => document.getElementById(id);
const money = v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const compact = v => (v < 0 ? '-' : '') + '$' + d3.format('.2~s')(Math.abs(v)).replace('G', 'B');
const pct = v => v === null ? 'never' : (v * 100).toFixed(1) + '%';
const perM = v => '$' + v.toFixed(v < 1 ? 3 : 2) + '/M';
const catalogs = new Map();
let defaults, report, selected, sortKey = 'best', sortDir = -1;

// The URL hash carries the scenario patch, so a link reproduces a view exactly.
const encode = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = text => JSON.parse(decodeURIComponent(escape(atob(text.replace(/-/g, '+').replace(/_/g, '/')))));

async function catalogFor(sources) {
  const key = sources.join(',');
  if (!catalogs.has(key)) {
    catalogs.set(key, fetch(`/api/catalog?sources=${encodeURIComponent(key)}`, { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load the catalogs.');
      return r.json();
    }));
  }
  return catalogs.get(key).catch(error => { catalogs.delete(key); throw error; });
}

async function run() {
  $('scenario-error').textContent = '';
  let patch;
  try { patch = JSON.parse($('scenario').value); } catch { $('scenario-error').textContent = 'Not valid JSON.'; return; }
  const scenario = mergeScenario(defaults, patch);
  try {
    const catalog = await catalogFor(scenario.catalog?.sources || []);
    report = buildReport(catalog.models, scenario, { curves: true });
    $('status').textContent = Object.entries(catalog.sources).map(([s, v]) => v.ok ? `${s}: ${v.models} priced models` : `${s}: unavailable`).join(' · ')
      + ` · ${report.models.length} included · ${report.scenario.fleet.gpuCount} GPUs at ${pct(report.scenario.fleet.utilization)} utilization`;
    history.replaceState(null, '', '#s=' + encode(patch));
  } catch (error) { $('scenario-error').textContent = error.message; return; }
  const ids = report.models.map(m => m.id);
  if (!ids.includes(selected)) selected = bestModels()[0]?.id;
  draw();
}

const best = m => Math.max(...m.results.map(r => r.profit));
const bestModels = () => [...report.models].sort((a, b) => best(b) - best(a));
const colorFor = i => d3.schemeTableau10[i % 10];

function frame(host, height = 260) {
  host.replaceChildren();
  const width = host.clientWidth || 600;
  const f = { width, height, left: 58, right: width - 22, top: 10, bottom: height - 30 };
  const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
  return { svg, f };
}

function axes(svg, f, x, y, xFormat, yFormat, xLabel) {
  svg.append('g').attr('transform', `translate(0,${f.bottom})`).call(d3.axisBottom(x).ticks(6).tickFormat(xFormat).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${f.left},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(yFormat).tickSize(-(f.right - f.left))).call(g => {
    g.select('.domain').remove(); g.selectAll('.tick line').attr('stroke', 'var(--line)');
  });
  svg.append('text').attr('x', (f.left + f.right) / 2).attr('y', f.height - 1).attr('text-anchor', 'middle').attr('fill', 'var(--muted)').text(xLabel);
}

function tooltip(event, lines) {
  const tip = $('tip');
  tip.replaceChildren(...lines.map((line, i) => { const el = document.createElement(i ? 'div' : 'strong'); el.textContent = line; return el; }));
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(event.clientX - box.left + 14, box.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${event.clientY - box.top + 14}px`;
}

function drawRanked() {
  const { svg, f } = frame($('ranked'), 300);
  const gpus = report.scenario.gpus, n = report.models.length;
  const series = gpus.map((g, i) => report.models.map(m => ({ m, r: m.results[i] }))
    .sort((a, b) => (a.r.breakEvenUtilization ?? Infinity) - (b.r.breakEvenUtilization ?? Infinity)));
  const cap = 1.5;
  const x = d3.scaleLinear().domain([0, Math.max(1, n - 1)]).range([f.left, f.right]);
  const y = d3.scaleLinear().domain([0, cap]).range([f.bottom, f.top]);
  axes(svg, f, x, y, d3.format('d'), d3.format('.0%'), 'Models, ranked per GPU');
  svg.append('line').attr('x1', f.left).attr('x2', f.right).attr('y1', y(1)).attr('y2', y(1)).attr('stroke', 'var(--negative)').attr('stroke-dasharray', '4 4');
  svg.append('text').attr('x', f.left + 4).attr('y', y(1) - 5).attr('fill', 'var(--negative)').text('100%: models above this line cannot break even');
  const util = report.scenario.fleet.utilization;
  svg.append('line').attr('x1', f.left).attr('x2', f.right).attr('y1', y(util)).attr('y2', y(util)).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '2 3');
  svg.append('text').attr('x', f.left + 4).attr('y', y(util) - 5).attr('fill', 'var(--muted)').text(`scenario utilization ${pct(util)}: models below are profitable`);
  const line = d3.line().x((d, i) => x(i)).y(d => y(Math.min(cap, d.r.breakEvenUtilization ?? cap)));
  series.forEach((s, i) => svg.append('path').datum(s).attr('d', line).attr('fill', 'none').attr('stroke', colorFor(i)).attr('stroke-width', 1.6));
  svg.append('rect').attr('x', f.left).attr('y', f.top).attr('width', f.right - f.left).attr('height', f.bottom - f.top).attr('fill', 'transparent')
    .on('pointermove', event => {
      const [px, py] = d3.pointer(event); const i = Math.max(0, Math.min(n - 1, Math.round(x.invert(px))));
      const k = d3.minIndex(series, s => Math.abs(y(Math.min(cap, s[i].r.breakEvenUtilization ?? cap)) - py)); const { m, r } = series[k][i];
      tooltip(event, [m.name, `${m.source} · ${gpus[k].name} at $${r.hourlyRate}/h`, `Break-even ${pct(r.breakEvenUtilization)}`, `Blended ${perM(r.blendedPrice)}`, `Profit ${money(r.profit)}/month`]);
    })
    .on('pointerleave', () => { $('tip').hidden = true; })
    .on('click', event => {
      const [px, py] = d3.pointer(event); const i = Math.max(0, Math.min(n - 1, Math.round(x.invert(px))));
      const k = d3.minIndex(series, s => Math.abs(y(Math.min(cap, s[i].r.breakEvenUtilization ?? cap)) - py));
      selected = series[k][i].m.id; drawModel();
    });
}

function drawCurve(host, axis, key, xFormat, xLabel, markerX) {
  const { svg, f } = frame(host);
  const m = report.models.find(v => v.id === selected); if (!m) return;
  const values = m.results.flatMap(r => r[key]);
  const x = d3.scaleLinear().domain(d3.extent(axis)).range([f.left, f.right]);
  const y = d3.scaleLinear().domain(d3.extent([0, ...values])).nice().range([f.bottom, f.top]);
  axes(svg, f, x, y, xFormat, compact, xLabel);
  svg.append('line').attr('x1', f.left).attr('x2', f.right).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--ink)');
  m.results.forEach((r, i) => {
    svg.append('path').datum(r[key]).attr('d', d3.line().x((d, j) => x(axis[j])).y(d => y(d))).attr('fill', 'none').attr('stroke', colorFor(i)).attr('stroke-width', 1.8);
    const mx = markerX(r);
    if (mx >= axis[0] && mx <= axis.at(-1)) {
      svg.append('circle').attr('cx', x(mx)).attr('cy', y(r.profit)).attr('r', 3.5).attr('fill', colorFor(i));
    }
  });
  svg.append('rect').attr('x', f.left).attr('y', f.top).attr('width', f.right - f.left).attr('height', f.bottom - f.top).attr('fill', 'transparent')
    .on('pointermove', event => {
      const j = d3.minIndex(axis, a => Math.abs(x(a) - d3.pointer(event)[0]));
      tooltip(event, [`${xFormat(axis[j])}`, ...m.results.map((r, i) => `${report.scenario.gpus[i].name}: ${money(r[key][j])}`)]);
    })
    .on('pointerleave', () => { $('tip').hidden = true; });
}

function drawModel() {
  $('model').value = selected;
  const m = report.models.find(v => v.id === selected); if (!m) return;
  const r = m.results[0];
  $('model-summary').textContent = `${m.source} · ${m.vendor} · lane ${r.lane} · input ${perM(r.prices.input)}, cached ${perM(r.prices.cached)}, output ${perM(r.prices.output)} · dots mark each GPU's scenario price and utilization`;
  drawCurve($('by-rate'), report.axes.hourlyRate, 'profitByHourlyRate', v => '$' + v.toFixed(2), '$ per GPU-hour', r => r.hourlyRate);
  drawCurve($('by-util'), report.axes.utilization, 'profitByUtilization', d3.format('.0%'), 'Paid utilization', () => report.scenario.fleet.utilization);
}

function drawTable() {
  const gpus = report.scenario.gpus, filter = $('filter').value.trim().toLowerCase();
  const value = (m, key) => key === 'best' ? best(m) : key === 'name' ? m.name.toLowerCase() : key === 'blend' ? m.results[0].blendedPrice : m.results[key].profit;
  const rows = report.models.filter(m => !filter || `${m.id} ${m.name} ${m.vendor}`.toLowerCase().includes(filter))
    .sort((a, b) => { const va = value(a, sortKey), vb = value(b, sortKey); return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir; }).slice(0, 300);
  const head = document.createElement('tr');
  [['name', 'Model'], [null, 'Source'], ['blend', 'Blended'], ...gpus.map((g, i) => [i, `${g.name} $${g.hourlyRate}/h`]), ['best', 'Best']].forEach(([key, label]) => {
    const th = document.createElement('th'); th.textContent = label + (key === sortKey ? (sortDir < 0 ? ' ↓' : ' ↑') : '');
    if (key !== null) th.addEventListener('click', () => { sortDir = sortKey === key ? -sortDir : -1; sortKey = key; drawTable(); });
    head.append(th);
  });
  const body = rows.map(m => {
    const tr = document.createElement('tr'); tr.dataset.id = m.id;
    const cells = [m.name, m.source, perM(m.results[0].blendedPrice), ...m.results.map(r => `${compact(r.profit)} · ${pct(r.breakEvenUtilization)}`), compact(best(m))];
    cells.forEach((text, i) => { const td = document.createElement('td'); td.textContent = text; if (i >= 3) td.className = text.startsWith('-') ? 'negative' : 'positive'; tr.append(td); });
    tr.addEventListener('click', () => { selected = m.id; drawModel(); $('model').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    return tr;
  });
  $('table').replaceChildren(head, ...body);
}

function draw() {
  if (!report || !window.d3) return;
  $('legend').replaceChildren(...report.scenario.gpus.map((g, i) => {
    const span = document.createElement('span'); const swatch = document.createElement('i'); swatch.style.background = colorFor(i);
    span.append(swatch, `${g.name} · $${g.hourlyRate}/h · ×${g.throughput}`); return span;
  }));
  $('model').replaceChildren(...bestModels().map(m => new Option(`${m.name} (${m.source})`, m.id)));
  drawRanked(); drawModel(); drawTable();
}

const copy = async (text, button) => {
  await navigator.clipboard.writeText(text);
  const label = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1200);
};

async function boot() {
  const response = await fetch('/api/scenario', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the default scenario.');
  defaults = await response.json();
  let patch = defaults;
  const hash = new URLSearchParams(location.hash.slice(1)).get('s');
  if (hash) { try { patch = mergeScenario(defaults, decode(hash)); } catch { /* fall back to defaults */ } }
  $('scenario').value = JSON.stringify(patch, null, 2);
  $('run').addEventListener('click', run);
  $('scenario').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
  $('reset').addEventListener('click', () => { $('scenario').value = JSON.stringify(defaults, null, 2); run(); });
  $('share').addEventListener('click', e => copy(location.href, e.currentTarget));
  $('curl').addEventListener('click', e => copy(`curl -s -X POST ${location.origin}/api/report -H 'content-type: application/json' -d '${$('scenario').value.replace(/'/g, "'\\''").replace(/\s*\n\s*/g, ' ')}'`, e.currentTarget));
  $('csv').addEventListener('click', () => {
    if (!report) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([reportToCsv(report)], { type: 'text/csv' }));
    a.download = 'tokenomics-report.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('model').addEventListener('change', () => { selected = $('model').value; drawModel(); });
  $('filter').addEventListener('input', drawTable);
  let lastWidth;
  new ResizeObserver(entries => { const w = entries[0].contentRect.width; if (w !== lastWidth) { lastWidth = w; requestAnimationFrame(draw); } }).observe($('ranked'));
  if (!window.d3) await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
  await run();
}
boot().catch(error => { $('load-error').textContent = error.message; $('load-error').hidden = false; });
