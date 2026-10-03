import { economics, profitAt, formatTokenCount } from '/economics.mjs';

const $ = id => document.getElementById(id);
const money = v => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = v => (v * 100).toFixed(0) + '%';
const price = v => '$' + v.toFixed(4) + '/M';
const compactMoney = v => v === 0 ? '$0' : (v < 0 ? '−' : '+') + '$' + Math.abs(v / 1000).toFixed(0) + 'k';
let models = [], current, scenario, references = [], months = 1, pinned = null, context;

function modelScenario(m, p = m.prices[0]) {
  return { gpus: m.defaultGpuCount, hourlyRate: m.defaultHourlyRate, hours: m.defaultHoursPerMonth,
    utilization: 1, otherMonthlyCost: 0, feeRate: 0, inputPrice: p.input, cachedPrice: p.cached, outputPrice: p.output,
    inputTpsPerGpu: m.inputTpsPerGpu, outputTpsPerGpu: m.outputTpsPerGpu, cacheHitRate: m.cacheHitRate };
}

function useModel(m) {
  current = m;
  scenario = modelScenario(m);
  pinned = null;
  references = m.prices.map((p, i) => ({ id: p.id, name: p.name, price: economics(modelScenario(m, p)).blend,
    color: i % 2 ? 'var(--reference-2)' : 'var(--reference-1)', visible: true }));
  $('chart-title').textContent = `${m.hardware} profitability`;
  const tps = economics(scenario).totalTps;
  const capacity = tps >= 1e6 ? `${(tps / 1e6).toFixed(3)}M` : `${(tps / 1000).toFixed(1)}k`;
  $('capacity-label').textContent = `${m.estimateFrom ? 'Estimated ' : ''}100% = ${capacity} total tokens/sec · ${scenario.hours} hours/month`;
  $('source-summary').textContent = `${m.name} · ${m.engine} · ${m.workload}. ${m.interactivity ? `Target: at least ${m.interactivity} output tokens/sec per user (p90). ` : ''}${scenario.gpus} GPUs at $${scenario.hourlyRate.toFixed(2)}/GPU-hour. Input cache hit rate: ${(m.cacheHitRate * 100).toFixed(1)}%. Total throughput includes cached input; generation alone is ${(m.outputTpsPerGpu * scenario.gpus).toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens/sec across the server.`;
  $('assumption-notes').textContent = m.assumptions;
  document.querySelector('.benchmark-credit:not(#catalog-credit)').hidden = m.capacityKind === 'generic';
  $('catalog-credit').hidden = m.capacityKind !== 'generic';
  const sources = m.sourceLinks || [['Benchmark results', m.source], ['Calculator data', m.sourceApi], ['SemiAnalysis AgentX methodology', m.methodology],
    ...m.prices.filter(p => p.source).map(p => [p.source.includes('openrouter.ai') ? 'OpenRouter prices' : `${p.name} prices`, p.source]), ...(m.extraSources || [])];
  $('source-links').replaceChildren(...sources.filter((source, i) => sources.findIndex(other => other[1] === source[1]) === i).map(([label, url]) => {
    const a = document.createElement('a'); a.textContent = label; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }));
  $('snapshot-label').textContent = m.capacityKind === 'generic' ? `Generic throughput, not a benchmark · Prices: live catalog, ${m.pricesAsOf}. Reference prices are not guaranteed sales.` : `Benchmark${m.estimateFrom ? ` (${m.estimateFrom})` : ''}: ${m.measuredAt} · Prices: ${m.pricesAsOf}. Reference prices are not guaranteed sales. Six months assumes steady prices, demand and workload mix.`;
  $('references').replaceChildren(...references.map(ref => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.reference = ref.id; button.setAttribute('aria-pressed', 'true');
    const swatch = document.createElement('span'); swatch.className = 'reference-swatch'; swatch.style.background = ref.color;
    button.append(swatch, `${ref.name}: ${price(ref.price)}`);
    button.addEventListener('click', () => { ref.visible = !ref.visible; button.setAttribute('aria-pressed', String(ref.visible)); draw(); });
    return button;
  }));
  render();
}

function render() {
  const rent = economics(scenario).rent;
  $('rental-summary').textContent = `${current.name} · ${scenario.gpus} GPUs · ${money(rent * months)} ${months === 1 ? '/ month' : '/ 6 months'} rent`;
  document.querySelectorAll('[data-months]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.months) === months)));
  draw();
}

function draw() {
  if (!window.d3 || !scenario) return;
  const d3 = window.d3, host = $('heatmap'), width = host.clientWidth;
  if (!width) return;
  const narrow = width < 500, height = narrow ? 373 : 438;
  const frame = { left: narrow ? 64 : 76, right: width - 12, top: 18, bottom: height - 73 };
  const e = economics(scenario);
  const ceiling = Math.ceil(Math.max(...references.map(r => r.price), e.breakEvenPrice) * 1.75 / .005) * .005;
  const x = d3.scaleLinear().domain([0, 1]).range([frame.left, frame.right]);
  const y = d3.scaleLinear().domain([0, ceiling]).range([frame.bottom, frame.top]);
  const profit = (u, p) => profitAt(scenario, u, p) * months;
  const limits = [profit(0, 0), profit(1, ceiling)];
  const theme = getComputedStyle(document.documentElement);
  const color = d3.scaleLinear().domain([limits[0], 0, Math.max(1, limits[1])]).range(['--loss', '--neutral', '--gain'].map(v => theme.getPropertyValue(v).trim())).clamp(true);
  host.replaceChildren();
  const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
  svg.append('title').text(`${current.hardware} profitability: utilization × price`);
  svg.append('desc').text('The curve is break-even. Above it is profit; below it is loss. Each utilization percentage has total paid tokens per month below it, including cached input. Hover or tap to inspect a point. Keyboard: focus the chart and use arrow keys; Enter pins and Escape clears.');
  svg.append('defs').append('clipPath').attr('id', 'plot-clip').append('rect').attr('x', frame.left).attr('y', frame.top).attr('width', frame.right - frame.left).attr('height', frame.bottom - frame.top);
  const field = svg.append('g').attr('clip-path', 'url(#plot-clip)');
  const cells = d3.range(50).flatMap(i => d3.range(75).map(j => ({ u: i / 50, p: j * ceiling / 75 })));
  field.selectAll('rect').data(cells).join('rect').attr('x', d => x(d.u)).attr('y', d => y(d.p + ceiling / 75))
    .attr('width', (frame.right - frame.left) / 50 + .4).attr('height', (frame.bottom - frame.top) / 75 + .4)
    .attr('fill', d => color(profit(d.u + .01, d.p + ceiling / 150)));
  const xTicks = narrow ? [0, .5, 1] : [0, .25, .5, .75, 1], yTicks = y.ticks(narrow ? 4 : 6);
  field.append('g').selectAll('line').data(xTicks).join('line').attr('x1', d => x(d)).attr('x2', d => x(d)).attr('y1', frame.top).attr('y2', frame.bottom).attr('stroke', 'var(--line)').attr('stroke-opacity', .7);
  field.append('g').selectAll('line').data(yTicks).join('line').attr('x1', frame.left).attr('x2', frame.right).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--line)').attr('stroke-opacity', .7);
  const boundary = d3.range(e.breakEvenPrice / ceiling, 1, .002).map(u => ({ u, p: e.breakEvenPrice / u }));
  boundary.push({ u: 1, p: e.breakEvenPrice });
  field.append('path').datum(boundary).attr('d', d3.line().x(d => x(d.u)).y(d => y(d.p))).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2);
  field.append('text').attr('x', x(.62)).attr('y', y(e.breakEvenPrice / .62) - 10).text('Break-even');
  field.append('text').attr('x', frame.right - 12).attr('y', frame.top + 22).attr('text-anchor', 'end').text('Profit');
  field.append('text').attr('x', frame.left + 12).attr('y', frame.bottom - 13).text('Loss');
  for (const ref of references.filter(r => r.visible)) {
    field.append('line').attr('data-reference-line', ref.id).attr('x1', frame.left).attr('x2', frame.right).attr('y1', y(ref.price)).attr('y2', y(ref.price)).attr('stroke', ref.color).attr('stroke-width', 1.5).attr('stroke-dasharray', '6 4');
    const u = e.breakEvenPrice / ref.price;
    if (u <= 1) {
      field.append('circle').attr('cx', x(u)).attr('cy', y(ref.price)).attr('r', 4).attr('fill', ref.color);
      field.append('text').attr('x', x(u) + (u > .85 ? -8 : 8)).attr('y', y(ref.price) + 17).attr('text-anchor', u > .85 ? 'end' : 'start').style('fill', ref.color).text(`${(u * 100).toFixed(1)}%`);
    }
  }
  svg.append('rect').attr('x', frame.left).attr('y', frame.top).attr('width', frame.right - frame.left).attr('height', frame.bottom - frame.top).attr('fill', 'none').attr('stroke', 'var(--line)');
  const gx = svg.append('g').attr('class', 'utilization-axis').attr('transform', `translate(0,${frame.bottom})`).call(d3.axisBottom(x).tickValues(xTicks).tickFormat(pct).tickSize(0).tickPadding(10));
  const gy = svg.append('g').attr('transform', `translate(${frame.left},0)`).call(d3.axisLeft(y).tickValues(yTicks).tickFormat(v => '$' + v.toFixed(3)).tickSize(0).tickPadding(8));
  gx.select('.domain').remove(); gy.select('.domain').remove();
  gx.selectAll('.tick text').text(null).append('tspan').attr('class', 'tick-percent').attr('x', 0).text(pct);
  gx.selectAll('.tick text').append('tspan').attr('class', 'tick-volume').attr('x', 0).attr('dy', '1.5em')
    .text(u => `${formatTokenCount(e.millionTokensAtFull * 1e6 * u)}/mo`);
  gx.selectAll('.tick').filter(d => d === 0).select('text').attr('text-anchor', 'start');
  gx.selectAll('.tick').filter(d => d === 1).select('text').attr('text-anchor', 'end');
  svg.append('text').attr('x', (frame.left + frame.right) / 2).attr('y', height - 9).attr('text-anchor', 'middle').text('Paid TPS utilization (%)');
  svg.append('text').attr('transform', `translate(14,${(frame.top + frame.bottom) / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('Blended price ($ / 1M total tokens)');
  const hover = field.append('g').attr('display', 'none').attr('pointer-events', 'none');
  hover.append('line').attr('class', 'hover-x').attr('stroke', 'var(--ink)').attr('stroke-opacity', .45);
  hover.append('line').attr('class', 'hover-y').attr('stroke', 'var(--ink)').attr('stroke-opacity', .45);
  hover.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('fill', 'var(--ink)');
  const hit = svg.append('rect').attr('class', 'plot-hit').attr('data-chart-hit', '').attr('x', frame.left).attr('y', frame.top).attr('width', frame.right - frame.left).attr('height', frame.bottom - frame.top).attr('fill', 'transparent').attr('pointer-events', 'all')
    .attr('tabindex', 0).attr('role', 'group').attr('aria-label', 'Profit chart. Use arrow keys to inspect; Enter to pin; Escape to clear.');
  context = { svg, frame, x, y, hover, width, height, ceiling, value: null };
  const pointerValue = event => {
    const [px, py] = d3.pointer(event, svg.node());
    return { u: Math.max(0, Math.min(1, x.invert(px))), p: Math.max(0, Math.min(ceiling, y.invert(py))) };
  };
  hit.on('pointermove', event => { if (!pinned) showPoint(pointerValue(event)); });
  hit.on('pointerleave', () => { if (!pinned) clearPoint(); });
  hit.on('click', event => { pinned = pinned ? null : pointerValue(event); if (pinned) showPoint(pinned, true); else clearPoint(); updateHint(); });
  hit.on('focus', () => { if (!context.value) showPoint({ u: .5, p: references[0].price }, true); });
  hit.on('blur', () => { if (!pinned) clearPoint(); });
  hit.on('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); pinned = null; clearPoint(); updateHint(); return; }
    const delta = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, ceiling / 100], ArrowDown: [0, -ceiling / 100] }[event.key];
    if (delta) {
      event.preventDefault(); const previous = context.value || { u: .5, p: references[0].price };
      const value = { u: Math.max(0, Math.min(1, previous.u + delta[0])), p: Math.max(0, Math.min(ceiling, previous.p + delta[1])) };
      if (pinned) pinned = value; showPoint(value, true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); pinned = pinned ? null : (context.value || { u: .5, p: references[0].price });
      if (pinned) showPoint(pinned, true); else clearPoint(); updateHint();
    }
  });
  $('color-legend').replaceChildren();
  const legend = d3.select($('color-legend')).append('svg').attr('viewBox', `0 0 ${width} 58`).attr('height', 58).attr('role', 'img').attr('aria-label', 'Color shows profit after GPU rent, from loss to profit.');
  const scale = d3.scaleLinear().domain(limits).range([frame.left, frame.right]);
  const grad = legend.append('defs').append('linearGradient').attr('id', 'profit-gradient');
  d3.range(101).forEach(i => grad.append('stop').attr('offset', `${i}%`).attr('stop-color', color(limits[0] + (limits[1] - limits[0]) * i / 100)));
  legend.append('text').attr('x', frame.left).attr('y', 12).text(`${months === 1 ? 'Monthly' : 'Six-month'} profit after GPU rent`);
  legend.append('rect').attr('x', frame.left).attr('y', 20).attr('width', frame.right - frame.left).attr('height', 9).attr('fill', 'url(#profit-gradient)');
  const legendValues = narrow ? [limits[0], 0, limits[1]] : [limits[0], 0, limits[1] / 2, limits[1]];
  legend.selectAll('.legend-value').data(legendValues).join('text').attr('class', 'legend-value').attr('x', d => scale(d)).attr('y', 47).attr('text-anchor', (d, i) => i === 0 ? 'start' : i === legendValues.length - 1 ? 'end' : 'middle').text(compactMoney);
  if (pinned) showPoint(pinned, true); else clearPoint();
  updateHint();
}

function updateHint() { $('interaction-hint').textContent = pinned ? 'Pinned · Click chart or press Esc to clear' : matchMedia('(pointer: coarse)').matches ? 'Tap the chart to inspect' : 'Hover to inspect · Click to pin'; }
function clearPoint() { context?.hover.attr('display', 'none'); if (context) context.value = null; $('chart-tooltip').hidden = true; $('selection').textContent = ''; }
function showPoint(value, announce = false) {
  if (!context) return;
  const { frame, x, y, hover, width, height } = context;
  context.value = value;
  hover.attr('display', null);
  hover.select('.hover-x').attr('x1', x(value.u)).attr('x2', x(value.u)).attr('y1', frame.top).attr('y2', frame.bottom);
  hover.select('.hover-y').attr('x1', frame.left).attr('x2', frame.right).attr('y1', y(value.p)).attr('y2', y(value.p));
  hover.select('.hover-dot').attr('cx', x(value.u)).attr('cy', y(value.p));
  const e = economics(scenario), revenue = e.millionTokensAtFull * value.u * value.p * months, rent = e.rent * months, profit = profitAt(scenario, value.u, value.p) * months;
  const tip = $('chart-tooltip');
  const point = document.createElement('div'); point.className = 'tip-point'; point.textContent = `${pct(value.u)} utilized · ${price(value.p)}`;
  const result = document.createElement('strong'); result.className = `tip-value ${profit >= 0 ? 'positive' : 'negative'}`; result.textContent = money(profit);
  const label = document.createElement('div'); label.className = 'tip-label'; label.textContent = `${months === 1 ? 'Monthly' : 'Six-month'} profit after GPU rent`;
  const rows = [['Revenue', money(revenue)], ['GPU rent', money(rent)]].map(([name, amount]) => {
    const row = document.createElement('div'); row.className = 'tip-row';
    const key = document.createElement('span'); key.textContent = name; const val = document.createElement('strong'); val.textContent = amount;
    row.append(key, val); return row;
  });
  tip.replaceChildren(point, result, label, ...rows); tip.hidden = false;
  const tipWidth = tip.offsetWidth, tipHeight = tip.offsetHeight;
  const desiredX = x(value.u) + 14 + tipWidth > width ? x(value.u) - tipWidth - 14 : x(value.u) + 14;
  const desiredY = y(value.p) - tipHeight - 14 < 0 ? y(value.p) + 14 : y(value.p) - tipHeight - 14;
  tip.style.left = `${Math.max(8, Math.min(width - tipWidth - 8, desiredX))}px`;
  tip.style.top = `${Math.max(0, Math.min(height - tipHeight, desiredY))}px`;
  if (announce) $('selection').textContent = `${point.textContent}. ${result.textContent} ${label.textContent.toLowerCase()}.`;
}

// Same base64url JSON encoding the explorer writes into its link hash.
const decodeScenario = text => decodeURIComponent(escape(atob(text.replace(/-/g, '+').replace(/_/g, '/'))));

async function boot() {
  const response = await fetch('/api/models', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the chart. Please reload and try again.');
  const data = await response.json(); models = data.models;
  // /?catalog=<source:slug>&gpu=<id>#s=<scenario> adds one catalog model from the explorer to the picker.
  const query = new URLSearchParams(location.search);
  if (query.get('catalog')) {
    const scenario = new URLSearchParams(location.hash.slice(1)).get('s');
    const params = new URLSearchParams({ id: query.get('catalog'), gpu: query.get('gpu') || '' });
    if (scenario) params.set('scenario', decodeScenario(scenario));
    const extra = await fetch(`/api/heatmap-model?${params}`, { cache: 'no-store' });
    if (!extra.ok) throw new Error((await extra.json().catch(() => ({}))).error || 'Could not load that catalog model.');
    models = [(await extra.json()).model, ...models];
  }
  $('model').replaceChildren(...models.map(m => new Option(`${m.name} · ${m.hardware}`, m.id)));
  $('model').closest('label').classList.toggle('multiple', models.length > 1);
  $('workspace').hidden = false; useModel(models[0]);
  $('model').addEventListener('change', () => useModel(models.find(m => m.id === $('model').value)));
  document.querySelectorAll('[data-months]').forEach(button => button.addEventListener('click', () => { months = Number(button.dataset.months); render(); }));
  let scheduled, lastWidth;
  new ResizeObserver(entries => {
    const width = entries[0].contentRect.width; if (width === lastWidth) return; lastWidth = width;
    cancelAnimationFrame(scheduled); scheduled = requestAnimationFrame(draw);
  }).observe($('heatmap'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { pinned = null; clearPoint(); updateHint(); } });
  if (!window.d3) window.addEventListener('load', draw, { once: true });
}
boot().catch(error => { $('load-error').textContent = error.message; $('load-error').hidden = false; });
