// M.ui.chart — простой линейный график на SVG (сигнал, скорость). Без библиотек.
// const c = M.ui.chart({ height: 120, min: -120, max: -60, series: [{ name: 'RSRP', cls: 's1' }], fmt: (v) => v });
// c.update([[…значения ряда 1…], […ряда 2…]]) — значения по времени, null — пропуск.
// c.setPhases([{at, label, cls}]) — фазы на графике: at — индекс первой точки, перед ней вертикальный разделитель;
// подпись — над линиями (opts.phaseBand оставляет под нее место сверху). lines: ['Прием 3 потока', '20,5 Мбит/с'] — подпись
// в две строки, short — короче, если у фазы мало места. opts.noLegend — без легенды.
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  return e;
};

M.ui.chart = (opts) => {
  opts = opts || {};
  let W = 600;
  const H = opts.height || 120;
  let last = null;
  const PAD = { l: 34, r: 6, t: opts.phaseBand ? 22 : 8, b: 14 };
  let phases = [];
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', height: H });
  if (opts.label) svg.setAttribute('aria-label', opts.label);
  const grid = svgEl('g', { class: 'chart-grid' });
  const lines = svgEl('g');
  const phaseG = svgEl('g', { class: 'chart-ph' });
  svg.appendChild(grid);
  svg.appendChild(phaseG);
  svg.appendChild(lines);
  const series = (opts.series || [{}]).map((s, i) => {
    const p = svgEl('polyline', { class: 'chart-line ' + (s.cls || 's' + (i + 1)), fill: 'none' });
    lines.appendChild(p);
    return p;
  });
  const wrap = M.ui.el('div', { class: 'chart-wrap' }, svg);
  const legend = opts.series && opts.series.length > 1 && !opts.noLegend ? M.ui.el('div', { class: 'chart-legend' },
    opts.series.map((s, i) => M.ui.el('span', { class: 'lg ' + (s.cls || 's' + (i + 1)) }, s.name))) : null;
  if (legend) wrap.appendChild(legend);

  const drawGrid = (min, max) => {
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = min + ((max - min) * i) / steps;
      const y = PAD.t + (H - PAD.t - PAD.b) * (1 - i / steps);
      grid.appendChild(svgEl('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }));
      const t = svgEl('text', { x: PAD.l - 4, y: y + 3, 'text-anchor': 'end' });
      t.textContent = opts.fmt ? opts.fmt(v) : Math.round(v);
      grid.appendChild(t);
    }
  };

  wrap.update = (data) => {
    last = data;
    const cw = Math.round(svg.getBoundingClientRect().width);
    if (cw > 50 && cw !== W) { W = cw; svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); }
    let min = opts.min;
    let max = opts.max;
    const all = [].concat(...data).filter((v) => v !== null && v !== undefined && isFinite(v));
    if (opts.auto || min === undefined || max === undefined) {
      if (all.length) {
        min = Math.min(opts.min !== undefined && !opts.auto ? opts.min : Infinity, ...all);
        max = Math.max(opts.max !== undefined && !opts.auto ? opts.max : -Infinity, ...all);
        if (opts.zero) min = Math.min(0, min);
        if (max - min < (opts.span || 1)) { max += (opts.span || 1) / 2; min -= (opts.span || 1) / 2; }
        if (opts.zero && min < 0 && all.every((v) => v >= 0)) min = 0;
      } else { min = 0; max = 1; }
    }
    drawGrid(min, max);
    const n = Math.max(opts.points || 0, ...data.map((d) => d.length), 2);
    while (phaseG.firstChild) phaseG.removeChild(phaseG.firstChild);
    phases.forEach((ph, pi) => {
      const left = PAD.l + ((W - PAD.l - PAD.r) * Math.max(0, ph.at - 0.5)) / (n - 1);
      if (ph.at > 0) phaseG.appendChild(svgEl('line', { x1: left, x2: left, y1: 2, y2: H - PAD.b }));
      let lines = ph.lines || (ph.label ? [ph.label] : []);
      if (!lines.length) return;
      const widest = (ls) => Math.max(...ls.map((l) => l.length * 6.2));
      const nx = phases[pi + 1];
      const room = (nx ? PAD.l + ((W - PAD.l - PAD.r) * (nx.at - 0.5)) / (n - 1) : W - PAD.r) - left - 6;
      if (ph.short && widest(lines) > room) lines = ph.short;
      // подпись от начала фазы; если у правого края не помещается — прижимается к нему
      const tooWide = left + 4 + widest(lines) > W - PAD.r;
      lines.forEach((l, i) => {
        const t = svgEl('text', { x: tooWide ? W - PAD.r : left + 4, y: 12 + i * 13, 'text-anchor': tooWide ? 'end' : 'start', class: ph.cls || '' });
        t.textContent = l;
        phaseG.appendChild(t);
      });
    });
    data.forEach((d, si) => {
      const pts = [];
      const off = n - d.length;
      d.forEach((v, i) => {
        if (v === null || v === undefined || !isFinite(v)) return;
        const x = PAD.l + ((W - PAD.l - PAD.r) * (i + off)) / (n - 1);
        const cv = Math.max(min, Math.min(max, v));
        const y = PAD.t + (H - PAD.t - PAD.b) * (1 - (cv - min) / (max - min));
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
      });
      if (series[si]) series[si].setAttribute('points', pts.join(' '));
    });
  };
  wrap.setPhases = (list) => {
    phases = list || [];
    if (opts.phaseBand) PAD.t = phases.some((x) => x.lines && x.lines.length > 1) ? 35 : 22;
  };
  wrap.update((opts.series || [{}]).map(() => []));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (last) wrap.update(last); });
    ro.observe(svg);
  }
  return wrap;
};
