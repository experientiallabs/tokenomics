// Run inside agent-browser eval --stdin, against local or deployed dashboard.
(async () => {
  const data = await (await fetch('/api/models', { cache: 'no-store' })).json();
  const { economics, formatTokenCount } = await import('/economics.mjs');
  const $ = id => document.getElementById(id);
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const select = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('change', { bubbles: true })); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const currency = n => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const scenario = (m, rate = m.defaultHourlyRate) => ({ ...m, gpus: m.defaultGpuCount, hourlyRate: rate, hours: 730,
    utilization: 1, otherMonthlyCost: 0, feeRate: 0, inputPrice: 0, cachedPrice: 0, outputPrice: 0 });
  let checked = 0;
  for (const m of data.models) {
    select('model', m.modelKey); select('gpu', m.hardwareKey); select('setup', m.id);
    const e = economics(scenario(m));
    assert($('rental-summary').textContent.includes(currency(e.rent)), `Rent: ${m.id}`);
    assert(Number($('gpu-rate').value) === m.defaultHourlyRate, `Default rate: ${m.id}`);
    assert(document.querySelectorAll('.tick-volume').length >= 3, `Token axis: ${m.id}`);
    assert([...document.querySelectorAll('.tick-volume')].some(el => el.textContent === `${formatTokenCount(e.millionTokensAtFull * 1e6)}/mo`), `Capacity: ${m.id}`);
    assert(!/NaN|Infinity/.test($('heatmap').innerHTML), `Invalid chart: ${m.id}`);
    assert($('references').children.length === m.prices.length, `Price references: ${m.id}`);
    if (!m.targetMet) assert(!$('benchmark-caveat').hidden, `Missing speed warning: ${m.id}`);
    const hit = document.querySelector('[data-chart-hit]');
    hit.focus(); hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert(!$('chart-tooltip').hidden, `Keyboard inspection: ${m.id}`);
    checked++;
  }
  select('model', 'dsv41flash'); select('gpu', 'b300');
  const m = data.models.find(m => m.id === $('setup').value);
  const hit = document.querySelector('[data-chart-hit]'), bounds = hit.getBoundingClientRect();
  const point = { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, bubbles: true };
  hit.dispatchEvent(new PointerEvent('pointermove', point));
  assert(!$('chart-tooltip').hidden, 'Pointer hover');
  hit.dispatchEvent(new MouseEvent('click', point));
  assert($('interaction-hint').textContent.startsWith('Pinned'), 'Click-to-pin');
  const yTicks = () => [...document.querySelectorAll('#heatmap svg > g:not(.utilization-axis) .tick text')].map(g => g.textContent).join('|');
  const ticks = yTicks();
  const rentBefore = economics(scenario(m)).rent;
  const before = $('chart-tooltip').querySelector('.tip-value').textContent;
  const parseMoney = text => Number(text.replace('−', '-').replace(/[$,]/g, ''));
  for (const rate of [7.25, 0, 25, 7.25]) {
    $('gpu-rate').value = rate; $('gpu-rate').dispatchEvent(new Event('input', { bubbles: true })); await frame();
    assert($('rental-summary').textContent.includes(currency(m.defaultGpuCount * rate * 730)), `Slider rent ${rate}`);
    assert($('gpu-rate-value').textContent === `$${rate.toFixed(2)}`, `Slider output ${rate}`);
    assert(!$('chart-tooltip').hidden, `Pin preserved ${rate}`);
    assert(!/NaN|Infinity/.test($('heatmap').innerHTML), `Slider finite chart ${rate}`);
    assert(yTicks() === ticks, `Price axis stays fixed ${rate}`);
    const after = parseMoney($('chart-tooltip').querySelector('.tip-value').textContent);
    assert(Math.abs(after - parseMoney(before) - rentBefore + m.defaultGpuCount * rate * 730) <= 1, `Pinned profit arithmetic ${rate}`);
  }
  assert($('chart-tooltip').querySelector('.tip-value').textContent !== before, 'Pinned profit updates');
  select('gpu', 'b200'); assert(Number($('gpu-rate').value) === 6.69, 'B200 market default');
  select('gpu', 'b300'); assert(Number($('gpu-rate').value) === 7.25, 'Per-GPU custom rate preserved');
  $('gpu-rate').value = 5.5; $('gpu-rate').dispatchEvent(new Event('input', { bubbles: true })); await frame();
  assert(!document.querySelector('[data-months]'), 'No period toggle');
  assert([...$('gpu').options].filter(o => o.disabled && o.text.includes('TPU')).length === 2, 'Unavailable TPU choices labeled');
  assert($('load-error').hidden, 'No load error');
  assert(document.documentElement.scrollWidth <= innerWidth, 'No horizontal overflow');
  return { curvesChecked: checked, models: new Set(data.models.map(m => m.modelKey)).size,
    gpuTypes: new Set(data.models.map(m => m.hardwareKey)).size, hover: 'pass', slider: 'pass', gpuDefaults: 'pass', tpu: 'unavailable, labeled', viewport: innerWidth };
})()
