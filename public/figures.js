// Turns the visual blocks in a model's answer into real UI. Specs are untrusted
// text from a model, so everything goes in through textContent, never as HTML.

const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function shell(spec, describedKind) {
  const figure = el('figure', 'viz');
  if (spec.title) figure.append(el('div', 'viz-title', spec.title));
  figure.setAttribute('aria-label', spec.title || describedKind);
  return figure;
}

const list = (value) => (Array.isArray(value) ? value : []);

function caption(figure, spec) {
  if (spec.caption) figure.append(el('figcaption', 'viz-caption', spec.caption));
}

/* ---------- timeline, steps, stats ---------- */

function timeline(spec) {
  const events = list(spec.events);
  if (!events.length) throw new Error('no events');
  const figure = shell(spec, 'Timeline');
  const ol = el('ol', 'timeline');
  for (const e of events) {
    const li = el('li');
    const body = el('div');
    body.append(el('div', 'tl-title', e.title));
    if (e.detail) body.append(el('div', 'tl-detail', e.detail));
    li.append(el('div', 'tl-date', e.date), body);
    ol.append(li);
  }
  figure.append(ol);
  caption(figure, spec);
  return figure;
}

function steps(spec) {
  const items = list(spec.steps);
  if (!items.length) throw new Error('no steps');
  const figure = shell(spec, 'Steps');
  const ol = el('ol', 'steps');
  for (const s of items) {
    const li = el('li');
    const body = el('div');
    body.append(el('div', 'step-title', s.title));
    if (s.detail) body.append(el('div', 'step-detail', s.detail));
    li.append(body);
    ol.append(li);
  }
  figure.append(ol);
  caption(figure, spec);
  return figure;
}

function stats(spec) {
  const items = list(spec.items);
  if (!items.length) throw new Error('no items');
  const figure = shell(spec, 'Key numbers');
  const wrap = el('div', 'stats');
  for (const s of items) {
    const stat = el('div', 'stat');
    stat.append(el('div', 'stat-value', s.value), el('div', 'stat-label', s.label));
    if (s.note) stat.append(el('div', 'stat-note', s.note));
    wrap.append(stat);
  }
  figure.append(wrap);
  caption(figure, spec);
  return figure;
}

/* ---------- charts ---------- */

let chartLib;
function loadChart() {
  chartLib ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/chart.js/dist/chart.umd.min.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('The chart library did not load.'));
    document.head.append(script);
  });
  return chartLib;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const isDark = () => css('--bg') === '#000000';

function formatter(unit) {
  const number = (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v);
  if (!unit) return number;
  return /^[$€£₹¥]/.test(unit) ? (v) => `${unit}${number(v)}` : (v) => `${number(v)}${unit === '%' ? '' : ' '}${unit}`;
}

// Names lines at their right-hand end, so identity never depends on colour alone.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart, _args, options) {
    if (!options.enabled) return;
    const { ctx } = chart;
    const placed = [];
    ctx.save();
    ctx.font = '500 13px "General Sans", system-ui';
    ctx.fillStyle = options.color;
    ctx.textBaseline = 'middle';
    const ends = chart.data.datasets.map((d, i) => {
      const points = chart.getDatasetMeta(i).data;
      const last = points[points.length - 1];
      return last && !chart.getDatasetMeta(i).hidden ? { name: d.label, x: last.x, y: last.y } : null;
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (const end of ends) {
      let { y } = end;
      for (const taken of placed) if (Math.abs(y - taken) < 15) y = taken + 15;
      placed.push(y);
      ctx.fillText(end.name, end.x + 8, y);
    }
    ctx.restore();
  },
};

function dataTable(spec, series, labels, format) {
  const details = el('details');
  details.append(el('summary', '', 'Show data'));
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const head = el('tr');
  head.append(el('th', '', spec.xLabel || ''));
  for (const s of series) head.append(el('th', '', s.name));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  labels.forEach((label, i) => {
    const row = el('tr');
    row.append(el('td', '', label));
    for (const s of series) row.append(el('td', '', s.data?.[i] === null || s.data?.[i] === undefined ? '' : format(s.data[i])));
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrap.append(table);
  details.append(wrap);
  return details;
}

function scatterTable(series, format) {
  const details = el('details');
  details.append(el('summary', '', 'Show data'));
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const head = el('tr');
  for (const t of ['Series', 'Point', 'x', 'y']) head.append(el('th', '', t));
  thead.append(head);
  const tbody = el('tbody');
  for (const s of series) {
    for (const p of list(s.points)) {
      const row = el('tr');
      row.append(el('td', '', s.name), el('td', '', p.label || ''), el('td', '', p.x), el('td', '', format(p.y)));
      tbody.append(row);
    }
  }
  table.append(thead, tbody);
  wrap.append(table);
  details.append(wrap);
  return details;
}

function chart(spec) {
  const type = spec.type;
  if (!['bar', 'line', 'area', 'donut', 'scatter'].includes(type)) throw new Error('unknown chart type');
  const all = list(spec.series);
  if (!all.length) throw new Error('no series');
  const series = all.slice(0, type === 'scatter' ? 3 : 8);
  const labels = list(spec.labels).map(String);
  if (type !== 'scatter' && !labels.length) throw new Error('no labels');

  const figure = shell(spec, 'Chart');
  if (all.length > series.length) {
    figure.append(el('div', 'viz-note', `Showing the first ${series.length} of ${all.length} series.`));
  }
  const box = el('div', 'chart-box');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', spec.title ? `Chart: ${spec.title}` : 'Chart');
  box.append(canvas);
  figure.append(box);
  caption(figure, spec);
  const format = formatter(spec.unit);
  figure.append(type === 'scatter' ? scatterTable(series, format) : dataTable(spec, series, labels, format));

  if (type === 'bar' && spec.horizontal) box.style.height = `${Math.max(180, labels.length * series.length * 26 + 80)}px`;

  loadChart().then((Chart) => {
    const palette = isDark() ? DARK : LIGHT;
    const ink = css('--ink');
    const muted = css('--muted');
    const grid = css('--surface-2');
    const bg = css('--bg');
    Chart.defaults.font.family = '"General Sans", system-ui, sans-serif';
    Chart.defaults.font.size = 13;
    Chart.defaults.color = muted;

    const horizontal = type === 'bar' && spec.horizontal;
    const stacked = Boolean(spec.stacked) && (type === 'bar' || type === 'area');
    const direct = (type === 'line' || type === 'area') && series.length >= 2 && series.length <= 4 && !stacked;
    let datasets;
    if (type === 'donut') {
      datasets = [{
        data: series[0].data, backgroundColor: labels.map((_, i) => palette[i % 8]),
        borderColor: bg, borderWidth: 2, hoverOffset: 4,
      }];
    } else if (type === 'scatter') {
      datasets = series.map((s, i) => ({
        label: s.name, data: list(s.points), backgroundColor: palette[i], borderColor: bg,
        borderWidth: 2, pointRadius: 6, pointHoverRadius: 8,
      }));
    } else {
      datasets = series.map((s, i) => ({
        label: s.name, data: s.data, backgroundColor: type === 'area' ? `${palette[i]}${stacked ? 'b3' : '33'}` : palette[i],
        borderColor: type === 'bar' ? bg : palette[i],
        borderWidth: type === 'bar' ? (stacked ? 2 : 0) : 2,
        borderRadius: type === 'bar' && !stacked ? 4 : 0, borderSkipped: type === 'bar' && !stacked ? 'start' : false,
        maxBarThickness: 44, fill: type === 'area' ? (stacked ? 'stack' : 'origin') : false,
        tension: 0, pointRadius: labels.length > 24 ? 0 : 3, pointHoverRadius: 5, spanGaps: true,
      }));
    }
    const axis = (title, showGrid, extra = {}) => ({
      grid: { display: showGrid, color: grid, drawTicks: false },
      border: { display: false },
      ticks: { color: muted, padding: 6, maxRotation: 0, autoSkipPadding: 14, ...extra },
      title: { display: Boolean(title), text: title || '', color: muted },
      stacked,
    });
    const valueTicks = { callback: (v) => format(v) };
    const scales = type === 'donut' ? {} : horizontal ? {
      x: { ...axis(spec.yLabel, true, valueTicks), beginAtZero: true },
      y: axis(spec.xLabel, false),
    } : type === 'scatter' ? {
      x: { ...axis(spec.xLabel, true), type: 'linear' },
      y: axis(spec.yLabel, true, valueTicks),
    } : {
      x: axis(spec.xLabel, false),
      y: { ...axis(spec.yLabel, true, valueTicks), beginAtZero: type !== 'line' },
    };

    new Chart(canvas, {
      type: type === 'donut' ? 'doughnut' : type === 'area' ? 'line' : type,
      data: { labels: type === 'scatter' ? undefined : labels, datasets },
      plugins: [endLabels],
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x', cutout: type === 'donut' ? '62%' : undefined,
        interaction: type === 'scatter' || type === 'donut' ? { mode: 'nearest', intersect: true } : { mode: 'index', intersect: false },
        layout: { padding: { right: direct ? 96 : 8 } },
        scales,
        plugins: {
          endLabels: { enabled: direct, color: ink },
          legend: {
            display: type === 'donut' || series.length >= 2, position: type === 'donut' ? 'right' : 'top', align: 'start',
            labels: { boxWidth: 12, boxHeight: 12, color: ink, padding: 14 },
          },
          tooltip: {
            backgroundColor: ink, titleColor: bg, bodyColor: bg, cornerRadius: 0, padding: 10, boxPadding: 4,
            callbacks: {
              label(ctx) {
                if (type === 'donut') return `${ctx.label}: ${format(ctx.parsed)}`;
                if (type === 'scatter') {
                  const p = ctx.raw;
                  return `${p.label || ctx.dataset.label}: ${p.x}, ${format(p.y)}`;
                }
                const value = horizontal ? ctx.parsed.x : ctx.parsed.y;
                return `${ctx.dataset.label}: ${format(value)}`;
              },
            },
          },
        },
      },
    });
  }).catch((err) => {
    box.replaceChildren(el('div', 'viz-pending', err.message));
    box.style.height = 'auto';
  });
  return figure;
}

/* ---------- diagrams ---------- */

let mermaidLib;
let mermaidTheme;
let diagramCount = 0;
async function loadMermaid() {
  mermaidLib ||= import('/vendor/mermaid/dist/mermaid.esm.min.mjs').then((m) => m.default);
  const mermaid = await mermaidLib;
  const dark = isDark();
  if (mermaidTheme !== dark) {
    mermaidTheme = dark;
    const surface = css('--surface');
    const ink = css('--ink');
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base', suppressErrorRendering: true,
      fontFamily: '"General Sans", system-ui, sans-serif',
      themeVariables: {
        darkMode: dark, background: css('--bg'), fontFamily: '"General Sans", system-ui, sans-serif', fontSize: '15px',
        primaryColor: surface, primaryBorderColor: surface, primaryTextColor: ink, secondaryColor: css('--surface-2'),
        tertiaryColor: surface, lineColor: css('--muted'), textColor: ink, noteBkgColor: css('--surface-2'),
        noteTextColor: ink, noteBorderColor: css('--surface-2'), actorBkg: surface, actorBorder: surface, actorTextColor: ink,
      },
    });
  }
  return mermaid;
}

function diagram(source) {
  const figure = el('figure', 'viz diagram');
  figure.append(el('div', 'viz-pending', 'Drawing diagram'));
  loadMermaid()
    .then((mermaid) => mermaid.render(`diagram-${++diagramCount}`, source))
    .then(({ svg }) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('bad svg');
      figure.replaceChildren(document.importNode(doc.documentElement, true));
    })
    .catch(() => figure.replaceWith(fallback('diagram', source)));
  return figure;
}

/* ---------- entry points ---------- */

export function fallback(kind, source) {
  const figure = el('figure', 'viz');
  figure.append(el('div', 'viz-note', `This ${kind} could not be drawn, so here is what the model sent.`));
  const box = el('div', 'code');
  const pre = el('pre');
  pre.append(el('code', '', source));
  box.append(pre);
  figure.append(box);
  return figure;
}

// Models sometimes wrap JSON in stray text or leave trailing commas.
function parseSpec(source) {
  const text = source.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return JSON.parse(text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
  }
}

const BUILDERS = { chart, timeline, steps, stats };

export function buildFigure(kind, source) {
  if (kind === 'mermaid') return diagram(source);
  try {
    return BUILDERS[kind](parseSpec(source));
  } catch {
    return fallback(kind, source);
  }
}
