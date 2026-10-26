// Miner Bridge dashboard - plain JS, no build step, no CDN (works offline behind HA Ingress).
// IMPORTANT: every URL is relative ("api/...", never "/api/...") so it works under /api/hassio_ingress/<token>/.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- state
const state = {
  devices: [],
  info: null,
  fleet: [],
  sparks: {},
  events: [],
  tab: 'overview',
  q: '',
  statusFilter: 'all',
  sort: 'health',
  range: 24,
  heatMetric: 'health',
  tableSort: { key: 'health', dir: 1 },
  drawerId: null,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(`mb.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`mb.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- formatting
const NF = {};
const nf = (v, digits = 1) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  NF[digits] ??= new Intl.NumberFormat('lt-LT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return NF[digits].format(v);
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const timeFmt = new Intl.DateTimeFormat('lt-LT', { hour: '2-digit', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('lt-LT', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('lt-LT', { dateStyle: 'short', timeStyle: 'medium' });

function hrParts(ths) {
  if (ths === null || ths === undefined) return { v: '–', u: 'TH/s' };
  return Math.abs(ths) >= 1000 ? { v: nf(ths / 1000, 2), u: 'PH/s' } : { v: nf(ths, 1), u: 'TH/s' };
}
function duration(s) {
  if (s === null || s === undefined) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
function ago(iso) {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `prieš ${s} s` : s < 3600 ? `prieš ${Math.round(s / 60)} min` : s < 86400 ? `prieš ${Math.round(s / 3600)} h` : `prieš ${Math.round(s / 86400)} d`;
}
const POWER_SRC = { measured: 'išmatuota PSU', calculated: 'apskaičiuota firmware', estimated: 'budėjimo įvertis', unmeasured: 'nematuojama' };
/** Power text honest about its source: "3,78 kW", "≈ 40 W" (estimate) or "nematuojama". */
function powerText(d, unit = 'kW') {
  const w = metricsOf(d).power_w, src = detailsOf(d)?.power_source;
  if (w === null || w === undefined) return src === 'unmeasured' ? 'nematuojama' : '–';
  const v = unit === 'kW' ? `${nf(w / 1000, 2)} kW` : `${nf(w, 0)} W`;
  return src === 'estimated' ? `≈ ${unit === 'kW' && w < 1000 ? `${nf(w, 0)} W` : v}` : v;
}
const shortModel = (m) => (m ?? '').replace(/^Antminer\s+/i, '').replace(/\s*\(.*\)$/, '');
const poolHost = (p) => (p ?? '').replace(/^stratum\+?\w*:\/\//, '').split(':')[0];

// ---------------------------------------------------------------- api
/** Server unreachable (stopped, restarting, add-on updating). Shown once as a banner, never as toasts. */
class OfflineError extends Error {}

let online = true;
let reconnectTimer = null;

function setOnline(value) {
  if (value === online) return;
  online = value;
  $('#conn-banner').hidden = value;
  document.body.classList.toggle('stale', !value);
  if (value) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
    toast('Ryšys su serveriu atkurtas');
    refreshAll();
  } else {
    $('#conn-poll').textContent = 'Serveris nepasiekiamas';
    $('#conn-mqtt').className = 'conn';
    $('#conn-mqtt').title = 'Būsena nežinoma (nėra ryšio su serveriu)';
  }
  if (!value && !reconnectTimer) {
    // Probe until the server is back (SSE reconnects by itself, this covers the REST data).
    reconnectTimer = setInterval(() => api('info').catch(() => {}), 5000);
  }
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    setOnline(false);
    throw new OfflineError('Nėra ryšio su serveriu');
  }
  // HA Ingress answers 502/503/504 while the add-on is stopped or restarting.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    setOnline(false);
    throw new OfflineError(`Serveris nepasiekiamas (HTTP ${res.status})`);
  }
  setOnline(true);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** For background refreshes: connection loss is already shown by the banner, only report real API errors. */
function reportBackgroundError(prefix, e) {
  if (!(e instanceof OfflineError)) toast(`${prefix}: ${e.message}`, true);
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

// ---------------------------------------------------------------- health helpers
const LEVELS = {
  crit: { rank: 0, icon: '!', label: 'Kritinė' },
  offline: { rank: 0, icon: '⏻', label: 'Offline' },
  warn: { rank: 1, icon: '!', label: 'Įspėjimas' },
  info: { rank: 2, icon: '↻', label: 'Info' },
  ok: { rank: 3, icon: '✓', label: 'Tvarkinga' },
  disabled: { rank: 4, icon: '–', label: 'Išjungta' },
};
const statusIcon = (level) => `<span class="si ${level}" aria-hidden="true"><span>${LEVELS[level]?.icon ?? '?'}</span></span>`;
/** Badge carries HEALTH (icon + word); the operating mode is shown separately via modeLabel(). */
const badgeText = (h) => (h.level === 'crit' || h.level === 'warn' || h.level === 'offline' ? LEVELS[h.level].label : h.label);
const badge = (h) => `<span class="badge">${statusIcon(h.level)}${esc(badgeText(h))}</span>`;
const modeLabel = (d) => (d.health.level === 'offline' ? 'neprisijungusi' : d.health.level === 'disabled' ? 'išjungta' : (d.health.label || '–').toLowerCase());
const displayName = (d) => d.name || d.hostname || shortModel(d.model) || d.id;
const metricsOf = (d) => d.latest?.metrics ?? {};
const detailsOf = (d) => d.latest?.details ?? null;
const isOfflineish = (d) => d.health.level === 'offline' || d.health.level === 'disabled';
const T = () => state.info?.thresholds ?? {};

/** Threshold class for a value: '', 'warn' or 'crit'. `higherIsBad` false = lower is bad. */
function tcls(v, warn, crit, higherIsBad = true) {
  if (v === null || v === undefined || warn === undefined) return '';
  if (higherIsBad) return crit !== undefined && v >= crit ? 'crit' : v >= warn ? 'warn' : '';
  return crit !== undefined && v < crit ? 'crit' : v < warn ? 'warn' : '';
}

const stateOf = (d) => detailsOf(d)?.state ?? '';
const STARTING_STATES = ['initializing', 'starting', 'restarting'];
/** Producing hashrate right now - includes Vnish "auto-tuning" (it mines while tuning). */
const isHashing = (d) => d.active && !isOfflineish(d) && !!d.latest && (metricsOf(d).hashrate_ths ?? 0) > 0;

const FILTERS = [
  { key: 'all', label: 'Visos', test: () => true },
  { key: 'crit', label: 'Kritinės', test: (d) => d.health.level === 'crit' || d.health.level === 'offline' },
  { key: 'warn', label: 'Įspėjimai', test: (d) => d.health.level === 'warn' },
  { key: 'notmining', label: 'Nekasa', test: (d) => d.active && !isHashing(d) },
  { key: 'tuning', label: 'Autotuning', test: (d) => d.active && stateOf(d) === 'auto-tuning' },
  { key: 'starting', label: 'Kraunasi', test: (d) => d.active && !isOfflineish(d) && STARTING_STATES.includes(stateOf(d)) },
  { key: 'ok', label: 'Tvarkingos', test: (d) => d.health.level === 'ok' },
  { key: 'disabled', label: 'Išjungtos', test: (d) => d.health.level === 'disabled' },
];

function visibleDevices() {
  const q = state.q.trim().toLowerCase();
  const f = FILTERS.find((x) => x.key === state.statusFilter) ?? FILTERS[0];
  const list = state.devices.filter(
    (d) => f.test(d) && (!q || [displayName(d), d.ip, d.model, d.hostname, d.mac, d.id].some((v) => v && String(v).toLowerCase().includes(q))),
  );
  const num = (v, dflt) => (v === null || v === undefined ? dflt : v);
  const by = {
    health: (a, b) => LEVELS[a.health.level].rank - LEVELS[b.health.level].rank || b.health.issues.length - a.health.issues.length || cmpName(a, b),
    name: cmpName,
    ip: cmpIp,
    hashrate_pct: (a, b) => num(a.health.hashrate_pct, 1e9) - num(b.health.hashrate_pct, 1e9),
    temp: (a, b) => num(metricsOf(b).temp_max_c, -1) - num(metricsOf(a).temp_max_c, -1),
    water_out: (a, b) => num(metricsOf(b).water_out_c, -1) - num(metricsOf(a).water_out_c, -1),
    efficiency: (a, b) => num(metricsOf(b).efficiency_jth, -1) - num(metricsOf(a).efficiency_jth, -1),
  };
  return list.sort(by[state.sort] ?? by.health);
}
function cmpName(a, b) { return displayName(a).localeCompare(displayName(b), 'lt', { numeric: true }); }
function cmpIp(a, b) {
  const n = (ip) => ip.split('.').reduce((s, o) => s * 256 + Number(o), 0);
  return n(a.ip) - n(b.ip);
}

// ---------------------------------------------------------------- charts (SVG, no deps)
const charts = new Map();
const ro = new ResizeObserver((entries) => entries.forEach((e) => charts.get(e.target) && drawChart(e.target, charts.get(e.target))));

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/**
 * opts: { series: [{name, color, points: [[ms, value|null]]}], unit, digits, refs: [{v, label, color}], yMin, height }
 * One y-axis only. Single series: area + line, title names it. Multi-series: legend above + endpoint labels.
 */
function lineChart(el, opts) {
  charts.set(el, opts);
  ro.observe(el);
  drawChart(el, opts);
}

function drawChart(el, o) {
  const W = el.clientWidth;
  if (!W) return;
  const H = o.height ?? 180;
  const m = { l: 46, r: o.series.length > 1 ? 44 : 14, t: 10, b: 24 };
  const pts = o.series.flatMap((s) => s.points.filter((p) => p[1] !== null));
  if (pts.length < 2) {
    el.innerHTML = `<div class="nodata" style="height:${H}px">Dar nepakanka duomenų</div>`;
    return;
  }
  const t0 = Math.min(...pts.map((p) => p[0])), t1 = Math.max(...pts.map((p) => p[0]));
  const vals = pts.map((p) => p[1]).concat((o.refs ?? []).map((r) => r.v));
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (o.yMin !== undefined) vMin = Math.min(o.yMin, vMin);
  const pad = (vMax - vMin) * 0.08 || 1;
  const ticks = niceTicks(o.yMin === 0 ? 0 : vMin - pad, o.yMax !== undefined ? Math.min(o.yMax, vMax + pad) : vMax + pad);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];
  const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - yLo) / (yHi - yLo || 1)) * (H - m.t - m.b);
  const digits = o.digits ?? 1;

  const span = t1 - t0;
  const xFmt = span > 36 * 3600e3 ? dayTimeFmt : timeFmt;
  const xTicks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);

  let svg = `<svg height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label ?? '')}">`;
  for (const tv of ticks) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(tv)}" y2="${y(tv)}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${m.l - 6}" y="${y(tv) + 3.5}" text-anchor="end" font-size="10.5" fill="var(--muted)">${nf(tv, tv % 1 ? 1 : 0)}</text>`;
  }
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="var(--axis)" stroke-width="1"/>`;
  xTicks.forEach((tv, i) => {
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    svg += `<text x="${x(tv)}" y="${H - 7}" text-anchor="${anchor}" font-size="10.5" fill="var(--muted)">${xFmt.format(tv)}</text>`;
  });
  let prevLabelY = -Infinity;
  for (const r of [...(o.refs ?? [])].sort((a, b) => b.v - a.v)) {
    if (r.v < yLo || r.v > yHi) continue;
    // Label above the line; if it would collide with the previous label, put it below.
    let ly = y(r.v) - 4;
    if (ly - prevLabelY < 12) ly = y(r.v) + 12;
    prevLabelY = ly;
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color ?? 'var(--muted)'}" stroke-width="1" stroke-dasharray="4 3" opacity=".9"/>`;
    svg += `<text x="${W - m.r - 4}" y="${ly}" text-anchor="end" font-size="10" fill="var(--ink-2)">${esc(r.label)}</text>`;
  }
  for (const s of o.series) {
    let d = '', area = '', run = [];
    const flush = () => {
      if (run.length > 1 && o.series.length === 1) {
        area += `M${x(run[0][0])},${y(yLo)} ` + run.map((p) => `L${x(p[0])},${y(p[1])}`).join(' ') + ` L${x(run[run.length - 1][0])},${y(yLo)} Z `;
      }
      run = [];
    };
    for (const p of s.points) {
      if (p[1] === null) { flush(); continue; }
      d += `${run.length ? 'L' : 'M'}${x(p[0])},${y(p[1])} `;
      run.push(p);
    }
    flush();
    if (area) svg += `<path d="${area}" fill="${s.color}" opacity=".12"/>`;
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (o.series.length > 1) {
      const last = [...s.points].reverse().find((p) => p[1] !== null);
      if (last) svg += `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 3.5}" font-size="10.5" fill="var(--ink-2)">${nf(last[1], digits)}</text>`;
    }
  }
  svg += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>`;
  o.series.forEach((s, i) => (svg += `<circle class="xd" data-i="${i}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`));
  svg += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg;

  // Hover: crosshair + tooltip on nearest timestamp
  const svgEl = el.firstChild, hit = $('.hit', svgEl), xh = $('.xh', svgEl), dots = $$('.xd', svgEl), tip = $('#tooltip');
  const times = o.series[0].points.map((p) => p[0]);
  const move = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0);
    let i = 0, best = Infinity;
    times.forEach((tv, k) => { const dd = Math.abs(tv - t); if (dd < best) { best = dd; i = k; } });
    const tv = times[i];
    xh.setAttribute('x1', x(tv)); xh.setAttribute('x2', x(tv)); xh.setAttribute('visibility', 'visible');
    let rows = '';
    o.series.forEach((s, k) => {
      const v = s.points[i]?.[1];
      const dot = dots[k];
      if (v === null || v === undefined) { dot.setAttribute('visibility', 'hidden'); }
      else { dot.setAttribute('cx', x(tv)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible'); }
      rows += `<div class="tt-row"><span><span class="sw" style="background:${s.color}"></span> ${esc(s.name)}</span><b>${nf(v, digits)} ${esc(o.unit ?? '')}</b></div>`;
    });
    tip.innerHTML = `<div class="tt-t">${fullFmt.format(tv)}</div>${rows}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tw - 8)}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    xh.setAttribute('visibility', 'hidden');
    dots.forEach((dd) => dd.setAttribute('visibility', 'hidden'));
  });
}

function sparkline(points, nominal) {
  const vals = (points ?? []).filter((p) => p[1] !== null);
  if (vals.length < 2) return '<svg viewBox="0 0 100 34"></svg>';
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const all = vals.map((p) => p[1]).concat(nominal ? [nominal] : []);
  const lo = Math.min(...all) * 0.97, hi = Math.max(...all) * 1.02 || 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v) => 32 - ((v - lo) / (hi - lo || 1)) * 30;
  let d = '', pen = false;
  for (const p of points) {
    if (p[1] === null) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)} `;
    pen = true;
  }
  const ref = nominal ? `<line x1="0" x2="100" y1="${y(nominal)}" y2="${y(nominal)}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : '';
  return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">${ref}<path d="${d}" fill="none" stroke="var(--s1)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// ---------------------------------------------------------------- KPIs
function renderKpis() {
  const active = state.devices.filter((d) => d.active);
  const live = active.filter((d) => !isOfflineish(d) && d.latest);
  const sum = (arr, f) => arr.reduce((s, d) => s + (f(d) ?? 0), 0);
  const hr = sum(live, (d) => metricsOf(d).hashrate_ths);
  const withNom = live.filter((d) => detailsOf(d)?.nominal_ths);
  const nomPct = withNom.length ? (sum(withNom, (d) => metricsOf(d).hashrate_ths) / sum(withNom, (d) => detailsOf(d).nominal_ths)) * 100 : null;
  const power = sum(live, (d) => metricsOf(d).power_w);
  const unmeasured = live.filter((d) => metricsOf(d).power_w == null).length;
  const estimated = live.filter((d) => detailsOf(d)?.power_source === 'estimated').length;
  const eff = hr > 0 && power > 0 ? power / hr : null;
  const hashing = active.filter(isHashing).length;
  const tuning = live.filter((d) => stateOf(d) === 'auto-tuning').length;
  const stopped = live.filter((d) => ['stopped', 'paused', 'shutting-down'].includes(stateOf(d))).length;
  const starting = live.filter((d) => STARTING_STATES.includes(stateOf(d))).length;
  const failed = live.filter((d) => stateOf(d) === 'failure').length;
  const offline = active.length - live.length;
  const notMining = active.length - hashing;
  const measuredCount = live.filter((d) => metricsOf(d).power_w != null).length;
  const crit = active.filter((d) => d.health.level === 'crit' || d.health.level === 'offline').length;
  const warn = active.filter((d) => d.health.level === 'warn').length;
  const hydro = live.filter((d) => metricsOf(d).water_in_c !== null && metricsOf(d).water_in_c !== undefined);
  const avg = (arr, f) => (arr.length ? sum(arr, f) / arr.length : null);
  const chipMax = live.reduce((mx, d) => Math.max(mx, metricsOf(d).temp_max_c ?? -Infinity), -Infinity);
  const hrp = hrParts(hr);
  const kpi = (label, value, unit, sub, cls = '') =>
    `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}<span class="unit">${unit}</span></div><div class="kpi-sub">${sub}</div></div>`;

  $('#kpis').innerHTML = [
    kpi('Parko hashrate', hrp.v, hrp.u, nomPct !== null ? `${nf(nomPct, 1)} % nominalo` : 'nominalas nežinomas'),
    kpi('Galia', measuredCount ? nf(power / 1000, 2) : '–', 'kW', unmeasured ? `+ ${unmeasured} kasykl. nematuojama (sustabdytos)` : estimated ? `įskaitant ${estimated} budėjimo įvert. · ≈ ${nf((power * 24) / 1000, 0)} kWh/d` : `≈ ${nf((power * 24) / 1000, 0)} kWh per parą`),
    kpi('Efektyvumas', nf(eff, 1), 'J/TH', 'parko vidurkis (W ÷ TH/s)'),
    kpi(
      'Kasyklos',
      `${hashing}`,
      `/ ${active.length} kasa`,
      notMining === 0
        ? `✓ visos kasa${tuning ? ` · ${tuning} autotuning` : ''}`
        : [`<b>${notMining} nekasa</b>`, offline && `${offline} offline`, failed && `${failed} gedimas`, stopped && `${stopped} sustabdyta`, starting && `${starting} kraunasi`, tuning && `${tuning} autotuning`].filter(Boolean).join(' · '),
      notMining ? 'kpi-link' : '',
    ),
    kpi(
      'Reikia dėmesio',
      `<span style="color:${crit ? 'var(--crit)' : 'inherit'}">${crit}</span>`,
      `krit. · ${warn} įsp.`,
      crit + warn === 0 ? '✓ visos tvarkingos' : 'žr. sąrašą žemiau',
      crit ? 'alert-crit' : warn ? 'alert-warn' : '',
    ),
    hydro.length
      ? kpi('Aušinimo vanduo', `${nf(avg(hydro, (d) => metricsOf(d).water_in_c), 1)} → ${nf(avg(hydro, (d) => metricsOf(d).water_out_c), 1)}`, '°C', (() => {
          const flows = hydro.map(flowInfo).filter((f) => f.v !== null);
          const low = flows.filter((f) => f.cls === 'crit').length;
          const min = flows.length ? Math.min(...flows.map((f) => f.v)) : null;
          return `max out ${nf(Math.max(...hydro.map((d) => metricsOf(d).water_out_c)), 1)} °C · min debitas ${nf(min, 1)} l/min${low ? ` · ${low} per mažas` : ''}`;
        })(), hydro.some((d) => flowInfo(d).cls === 'crit') ? 'alert-crit' : '')
      : kpi('Lustų temp. max', nf(Number.isFinite(chipMax) ? chipMax : null, 0), '°C', 'karščiausia kasykla'),
  ].join('');

  const conn = $('#conn-mqtt');
  const mq = state.info?.mqtt;
  conn.className = `conn ${mq?.connected ? 'ok' : mq?.enabled ? 'bad' : ''}`;
  conn.title = !mq?.enabled ? 'MQTT išjungtas' : mq.connected ? 'MQTT prisijungęs' : 'MQTT atsijungęs';
  const cyc = state.info?.lastCycle;
  $('#conn-poll').textContent = cyc ? `Apklausa ${ago(cyc.at)} · ${cyc.durationMs} ms` : 'Apklausa –';
}

// ---------------------------------------------------------------- filters
function renderChips() {
  $('#status-chips').innerHTML = FILTERS.map((f) => {
    const n = state.devices.filter(f.test).length;
    // 'Nekasa' stays visible at 0 - it is the at-a-glance "all miners hashing" check
    if (f.key !== 'all' && f.key !== 'notmining' && f.key !== state.statusFilter && n === 0) return '';
    return `<button class="chip" data-filter="${f.key}" aria-pressed="${state.statusFilter === f.key}">${f.label} <span class="n">${n}</span></button>`;
  }).join('');
}

// ---------------------------------------------------------------- overview
function renderAttention() {
  const items = [];
  for (const d of state.devices) {
    if (!d.active) continue;
    const problems = d.health.issues.filter((i) => i.level !== 'info');
    if (problems.length) items.push({ d, text: problems.map((i) => i.text).join(' · '), lvl: d.health.level === 'offline' ? 'offline' : problems[0].level });
  }
  items.sort((a, b) => LEVELS[a.lvl].rank - LEVELS[b.lvl].rank || cmpName(a.d, b.d));
  const crit = items.filter((x) => x.lvl === 'crit' || x.lvl === 'offline').length;
  const cnt = $('#attention-count');
  cnt.textContent = items.length;
  cnt.className = `count-badge${crit ? ' has-crit' : ''}`;
  $('#attention-list').innerHTML = items.length
    ? items
        .map(
          (x) => `<li data-id="${esc(x.d.id)}" tabindex="0">${statusIcon(x.lvl)}<div><div class="who">${esc(displayName(x.d))}</div><div class="what">${esc(x.text)}</div></div><span class="muted small">${esc(x.d.ip)}</span></li>`,
        )
        .join('')
    : `<li class="ok-all">✓ Problemų nėra – visos kasyklos dirba normaliai.</li>`;
}

/** Coolant flow: current estimate, or the last one taken while mining (stopped miners make no heat). */
function flowInfo(d) {
  const h = d.health;
  const cur = h.flow_lpm, last = h.flow_last, req = h.flow_required_lpm;
  const v = cur ?? last?.lpm ?? null;
  const isLast = cur === null && v !== null;
  return {
    v, req, isLast,
    cls: v !== null && req && v < req ? 'crit' : '',
    text: v === null ? (req ? `– / ${nf(req, 0)} l/min` : '–') : `${nf(v, 1)}${req ? ` / ${nf(req, 0)}` : ''} l/min`,
    title: `Apskaičiuota iš galios ir ΔT${isLast ? ` (paskutinė reikšmė kasant, ${ago(last.at)})` : ''}. Skystis: ${state.info?.coolant?.label ?? '?'}. Privaloma: ${h.flow_required_spec ?? 'nežinoma'}`,
  };
}

function statBox(label, value, cls = '') {
  return `<div class="stat ${cls}"><div class="l">${label}</div><div class="v">${value}</div></div>`;
}

function minerCard(d) {
  const h = d.health, m = metricsOf(d), det = detailsOf(d), t = T();
  const off = isOfflineish(d) || !d.latest;
  const hr = hrParts(off ? null : m.hashrate_ths);
  const pct = off ? null : h.hashrate_pct;
  const pctCls = tcls(pct, t.hashrateWarnPct, t.hashrateCritPct, false);
  const hydro = m.water_in_c !== null && m.water_in_c !== undefined;
  const problems = h.issues.filter((i) => i.level !== 'info').slice(0, 3);

  const stats1 = [
    statBox('Galia', off ? '–' : `<span title="${esc(POWER_SRC[det?.power_source] ?? '')}">${powerText(d)}</span>`),
    statBox('Efektyv.', off ? '–' : `${nf(m.efficiency_jth, 1)} J/TH`),
    statBox('Lustai', off ? '–' : `${nf(m.temp_max_c, 0)} °C`, off ? '' : tcls(m.temp_max_c, t.tempWarnC, t.tempCriticalC)),
  ];
  const stats2 = hydro
    ? [
        statBox('Vanduo', off ? '–' : `${nf(m.water_in_c, 0)}→${nf(m.water_out_c, 0)} °C`, off ? '' : tcls(m.water_out_c, t.waterOutWarnC, t.waterOutCritC)),
        statBox('ΔT', off ? '–' : `${nf(h.water_delta_c, 1)} °C`, off ? '' : tcls(h.water_delta_c, t.waterDeltaWarnC)),
        (() => {
          const f = flowInfo(d);
          return statBox(f.isLast ? 'Debitas (pask.)' : 'Debitas', `<span title="${esc(f.title)}">${f.text}</span>`, f.cls);
        })(),
      ]
    : [
        statBox('Ventil.', off || m.fan_rpm_avg == null ? '–' : `${nf(m.fan_rpm_avg, 0)}`),
        statBox('HW klaid.', off ? '–' : nf(m.hw_errors, 0)),
        statBox('Atmesta', h.reject_pct === null ? '–' : `${nf(h.reject_pct, 2)} %`, tcls(h.reject_pct, t.rejectWarnPct, t.rejectCritPct)),
      ];

  const chains = !off && det?.chains?.length
    ? `<div class="chains">${det.chains
        .map((c) => {
          const cp = c.ideal_ths ? (c.hashrate_ths / c.ideal_ths) * 100 : null;
          const cc = c.state === 'failure' || c.state === 'disconnected' ? 'crit' : tcls(cp, t.hashrateWarnPct, t.hashrateCritPct, false);
          return `<div class="chain" title="Grandinė ${esc(c.id)}: ${esc(c.state ?? '')}, ${nf(c.hashrate_ths, 1)} / ${nf(c.ideal_ths, 1)} TH/s"><div class="l"><span>G${esc(c.id)}</span><b>${c.state === 'failure' ? 'GEDIMAS' : cp === null ? '–' : `${nf(cp, 0)}%`}</b></div><div class="bar"><i class="${cc}" style="width:${Math.max(0, Math.min(100, cp ?? 0))}%"></i></div></div>`;
        })
        .join('')}</div>`
    : '';

  return `<article class="miner lvl-${h.level}" data-id="${esc(d.id)}" tabindex="0" aria-label="${esc(displayName(d))}: ${esc(h.label)}">
    <div class="m-head">
      <div style="min-width:0"><div class="m-name">${esc(displayName(d))}</div><div class="m-sub">${d.rack ? `<b>${esc(locCode(d))}</b> · ` : ''}${esc(d.ip)} · ${esc(shortModel(d.model) || d.driver)} · ${esc(modeLabel(d))}</div></div>
      ${badge(h)}
    </div>
    <div class="m-hr"><span class="v">${hr.v}</span><span class="u">${hr.u}</span><span class="pct">${pct === null ? '' : `${nf(pct, 1)} % nom.`}</span></div>
    <div class="bar" title="% nuo nominalo"><i class="${pctCls}" style="width:${Math.max(0, Math.min(100, pct ?? 0))}%"></i></div>
    <div class="spark">${sparkline(state.sparks[d.id], det?.nominal_ths)}</div>
    <div class="m-stats">${stats1.join('')}</div>
    <div class="m-stats">${stats2.join('')}</div>
    ${chains}
    ${d.commands.includes('start') && isStopped(d) ? `<div class="quick"><span class="muted small">Kasimas sustabdytas</span><button class="btn primary small-btn" data-quick="start">▶ Paleisti kasimą</button></div>` : ''}
    ${problems.length ? `<ul class="m-issues">${problems.map((i) => `<li>${statusIcon(i.level)}${esc(i.text)}</li>`).join('')}</ul>` : ''}
    <div class="m-foot">
      <span title="Laikas kasimo būsenoje">⏱ ${off ? ago(d.last_seen) : duration(m.uptime_s)}</span>
      ${det?.pool ? `<span title="${esc(det.pool)}">⛁ ${esc(poolHost(det.pool))}</span>` : ''}
      ${hydro && h.reject_pct !== null ? `<span title="Atmesti share'ai">atm. ${nf(h.reject_pct, 2)} %</span>` : ''}
      <span>${esc(d.firmware ?? d.driver)}</span>
    </div>
  </article>`;
}

function renderGrid() {
  const list = visibleDevices();
  $('#miner-grid').innerHTML = list.map(minerCard).join('');
  $('#empty-state').hidden = state.devices.length > 0;
}

function renderFleetCharts() {
  const pts = state.fleet.map((r) => [new Date(r.bucket).getTime(), r]);
  const latestHr = state.fleet.length ? state.fleet[state.fleet.length - 1].hashrate_ths : null;
  const avgPw = state.fleet.length ? state.fleet.reduce((s, r) => s + (r.power_w ?? 0), 0) / state.fleet.length : null;
  $('#fleet-hr-sub').textContent = latestHr === null ? '' : `· ${state.range} h`;
  $('#fleet-pw-sub').textContent = avgPw === null ? '' : `· vid. ${nf(avgPw / 1000, 2)} kW`;
  const nominal = state.devices.filter((d) => d.active).reduce((s, d) => s + (detailsOf(d)?.nominal_ths ?? 0), 0);
  lineChart($('#chart-fleet-hr'), {
    label: 'Parko hashrate',
    unit: 'TH/s',
    digits: 1,
    yMin: 0,
    series: [{ name: 'Hashrate', color: 'var(--s1)', points: pts.map(([t, r]) => [t, r.hashrate_ths]) }],
    refs: nominal ? [{ v: nominal, label: `nominalas ${nf(nominal, 0)}`, color: 'var(--muted)' }] : [],
  });
  lineChart($('#chart-fleet-pw'), {
    label: 'Parko galia',
    unit: 'kW',
    digits: 2,
    yMin: 0,
    series: [{ name: 'Galia', color: 'var(--s1)', points: pts.map(([t, r]) => [t, r.power_w === null ? null : r.power_w / 1000]) }],
  });
}

// ---------------------------------------------------------------- table
const COLUMNS = [
  { key: 'health', label: 'Būsena', sort: (d) => LEVELS[d.health.level].rank, html: (d) => badge(d.health) },
  { key: 'mode', label: 'Režimas', sort: (d) => modeLabel(d), html: (d) => esc(modeLabel(d)) },
  { key: 'name', label: 'Kasykla', sort: (d) => displayName(d).toLowerCase(), html: (d) => `<b>${esc(displayName(d))}</b>` },
  { key: 'loc', label: 'Vieta', sort: (d) => (d.rack ? d.rack * 10000 + d.shelf * 100 + d.slot : 1e9), html: (d) => esc(locCode(d) || '–') },
  { key: 'ip', label: 'IP', sort: (d) => d.ip.split('.').reduce((s, o) => s * 256 + Number(o), 0), html: (d) => esc(d.ip) },
  { key: 'model', label: 'Modelis', sort: (d) => d.model ?? '', html: (d) => esc(shortModel(d.model)) },
  { key: 'hr', label: 'TH/s', num: true, sort: (d) => metricsOf(d).hashrate_ths, html: (d) => nf(metricsOf(d).hashrate_ths, 1) },
  { key: 'pct', label: '% nom.', num: true, sort: (d) => d.health.hashrate_pct, html: (d) => nf(d.health.hashrate_pct, 1), cls: (d) => tcls(d.health.hashrate_pct, T().hashrateWarnPct, T().hashrateCritPct, false) },
  { key: 'pw', label: 'Galia W', num: true, sort: (d) => metricsOf(d).power_w, html: (d) => (metricsOf(d).power_w == null ? esc(powerText(d, 'W')) : `${detailsOf(d)?.power_source === 'estimated' ? '≈ ' : ''}${nf(metricsOf(d).power_w, 0)}`) },
  { key: 'eff', label: 'J/TH', num: true, sort: (d) => metricsOf(d).efficiency_jth, html: (d) => nf(metricsOf(d).efficiency_jth, 1) },
  { key: 'chip', label: 'Lustai °C', num: true, sort: (d) => metricsOf(d).temp_max_c, html: (d) => nf(metricsOf(d).temp_max_c, 0), cls: (d) => tcls(metricsOf(d).temp_max_c, T().tempWarnC, T().tempCriticalC) },
  { key: 'win', label: 'Vand. in', num: true, sort: (d) => metricsOf(d).water_in_c, html: (d) => nf(metricsOf(d).water_in_c, 1), cls: (d) => tcls(metricsOf(d).water_in_c, T().waterInWarnC) },
  { key: 'wout', label: 'Vand. out', num: true, sort: (d) => metricsOf(d).water_out_c, html: (d) => nf(metricsOf(d).water_out_c, 1), cls: (d) => tcls(metricsOf(d).water_out_c, T().waterOutWarnC, T().waterOutCritC) },
  { key: 'flow', label: 'Debitas l/min', num: true, sort: (d) => flowInfo(d).v, html: (d) => { const f = flowInfo(d); return f.v === null ? '–' : `<span title="${esc(f.title)}">${f.isLast ? '≤ ' : ''}${nf(f.v, 1)}${f.req ? ` / ${nf(f.req, 0)}` : ''}</span>`; }, cls: (d) => flowInfo(d).cls },
  { key: 'dt', label: 'ΔT', num: true, sort: (d) => d.health.water_delta_c, html: (d) => nf(d.health.water_delta_c, 1), cls: (d) => tcls(d.health.water_delta_c, T().waterDeltaWarnC) },
  { key: 'rej', label: 'Atmesta %', num: true, sort: (d) => d.health.reject_pct, html: (d) => nf(d.health.reject_pct, 2), cls: (d) => tcls(d.health.reject_pct, T().rejectWarnPct, T().rejectCritPct) },
  { key: 'up', label: 'Veikia', num: true, sort: (d) => metricsOf(d).uptime_s, html: (d) => (isOfflineish(d) ? '–' : duration(metricsOf(d).uptime_s)) },
  { key: 'issues', label: 'Problemos', sort: (d) => d.health.issues.length, html: (d) => esc(d.health.issues.filter((i) => i.level !== 'info').map((i) => i.text).join(' · ')), tdClass: 'issues' },
];

function renderTable() {
  const { key, dir } = state.tableSort;
  $('#table-head').innerHTML = `<tr>${COLUMNS.map(
    (c) => `<th class="${c.num ? 'num' : ''}" data-key="${c.key}" aria-sort="${c.key === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}${c.key === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`,
  ).join('')}</tr>`;
  const col = COLUMNS.find((c) => c.key === key) ?? COLUMNS[0];
  const list = visibleDevices().sort((a, b) => {
    const va = col.sort(a), vb = col.sort(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  });
  $('#table-body').innerHTML = list
    .map(
      (d) => `<tr class="lvl-${d.health.level}" data-id="${esc(d.id)}" tabindex="0">${COLUMNS.map(
        (c) => `<td class="${[c.num ? 'num' : '', c.tdClass ?? '', c.cls ? (c.cls(d) ? `cell-${c.cls(d)}` : '') : ''].join(' ')}">${c.html(d)}</td>`,
      ).join('')}</tr>`,
    )
    .join('');
}

// ---------------------------------------------------------------- heatmap
const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const HEAT_METRICS = [
  { key: 'health', label: 'Sveikata' },
  { key: 'pct', label: '% nominalo', unit: '%', digits: 0, get: (d) => d.health.hashrate_pct },
  { key: 'hr', label: 'Hashrate', unit: 'TH/s', digits: 0, get: (d) => metricsOf(d).hashrate_ths },
  { key: 'chip', label: 'Lustų temp.', unit: '°C', digits: 0, get: (d) => metricsOf(d).temp_max_c },
  { key: 'wout', label: 'Vanduo out', unit: '°C', digits: 1, get: (d) => metricsOf(d).water_out_c },
  { key: 'dt', label: 'Vandens ΔT', unit: '°C', digits: 1, get: (d) => d.health.water_delta_c },
  { key: 'flow', label: 'Debitas', unit: 'l/min', digits: 1, get: (d) => flowInfo(d).v },
  { key: 'eff', label: 'Efektyvumas', unit: 'J/TH', digits: 1, get: (d) => metricsOf(d).efficiency_jth },
  { key: 'pw', label: 'Galia', unit: 'kW', digits: 2, get: (d) => (metricsOf(d).power_w == null ? null : metricsOf(d).power_w / 1000) },
];
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#0b0b0b' : '#ffffff';
}
const STATUS_HEX = { ok: '#0ca30c', warn: '#fab219', crit: '#d03b3b', offline: '#d03b3b' };

/** Color scale for a metric over a set of devices + its legend (shared by heatmap and container view). */
function heatScale(metric, list) {
  // In dark mode the ramp runs dark->light so low values recede into the surface.
  const ramp = isDark() ? [...SEQ].reverse().slice(1) : SEQ;
  let lo = 0, hi = 1, legend;
  if (metric.get) {
    const vals = list.filter((d) => !isOfflineish(d)).map(metric.get).filter((v) => v !== null && v !== undefined);
    if (vals.length) { lo = Math.min(...vals); hi = Math.max(...vals); }
    legend = vals.length
      ? `<span>${nf(lo, metric.digits)} ${metric.unit}</span><span class="ramp" style="background:linear-gradient(90deg,${ramp.join(',')})"></span><span>${nf(hi, metric.digits)} ${metric.unit}</span><span class="key">${statusIcon('offline')} offline</span>`
      : '';
  } else {
    legend = ['ok', 'info', 'warn', 'crit', 'offline', 'disabled'].map((l) => `<span class="key">${statusIcon(l)} ${LEVELS[l].label}</span>`).join('');
  }
  return { metric, ramp, lo, hi, legend };
}

/** Short tile text for the most important issue (full text stays in the tooltip). */
const SHORT_ISSUE = {
  offline: 'Offline',
  coolant_flow: 'Debitas ↓',
  overheat_stop: 'Perkaito',
  overheat_repeat: 'Perkaista',
  overheat_once: 'Perkaito',
  chain_break: 'Grandinė',
  device_error: 'Gedimas',
  failure: 'Gedimas',
  hashrate: 'Hashrate ↓',
  rejects: 'Atmetimai',
  water_out: 'Vanduo ↑',
  water_in: 'Vanduo in ↑',
  water_delta: 'ΔT ↑',
  stale: 'Seni duom.',
  stuck: 'Užstrigo',
};
function shortIssue(i) {
  if (!i) return null;
  if (i.code === 'chip_temp') return i.text.replace(/^Lustai\s*/, '');
  if (i.code?.startsWith('chain_')) return 'Grandinė ↓';
  return SHORT_ISSUE[i.code] ?? i.text;
}

/** One colored tile for a device. `label` overrides the shown name (e.g. slot code). */
function heatCell(d, scale, label) {
  const { metric, ramp, lo, hi } = scale;
  const name = esc(label ?? displayName(d));
  const full = esc(displayName(d));
  const lvl = d.health.level;
  const icon = lvl === 'ok' ? '' : statusIcon(lvl);
  const loc = detailsOf(d)?.locating ? '<span class="blink" title="LED mirksi">◉</span>' : '';
  if (!metric.get) {
    const bg = STATUS_HEX[lvl];
    const style = bg ? `background:${bg};color:${inkFor(bg)}` : '';
    return `<div class="cell ${bg ? '' : 'nodata'}" style="${style}" data-id="${esc(d.id)}" tabindex="0" title="${full} · ${esc(d.health.label)}${d.health.issues.length ? ' · ' + esc(d.health.issues.map((i) => i.text).join('; ')) : ''}"><span class="n">${icon}${name}${loc}</span><span class="v">${esc(shortIssue(d.health.issues.find((i) => i.level !== 'info')) ?? d.health.label)}</span></div>`;
  }
  const v = isOfflineish(d) ? null : metric.get(d);
  if (v === null || v === undefined) {
    return `<div class="cell nodata" data-id="${esc(d.id)}" tabindex="0" title="${full}: nėra duomenų"><span class="n">${icon}${name}${loc}</span><span class="v">–</span></div>`;
  }
  const idx = Math.round(((v - lo) / (hi - lo || 1)) * (ramp.length - 1));
  const bg = ramp[Math.max(0, Math.min(ramp.length - 1, idx))];
  return `<div class="cell" style="background:${bg};color:${inkFor(bg)}" data-id="${esc(d.id)}" tabindex="0" title="${full}: ${nf(v, metric.digits)} ${metric.unit}"><span class="n">${icon}${name}${loc}</span><span class="v">${nf(v, metric.digits)}</span></div>`;
}

const metricButtons = (current) => HEAT_METRICS.map((x) => `<button data-metric="${x.key}" aria-pressed="${x.key === current}">${x.label}</button>`).join('');

function renderHeatmap() {
  const metric = HEAT_METRICS.find((x) => x.key === state.heatMetric) ?? HEAT_METRICS[0];
  $('#heat-metric').innerHTML = metricButtons(metric.key);
  const list = visibleDevices().sort(cmpIp);
  const scale = heatScale(metric, list);
  $('#heat-legend').innerHTML = scale.legend;
  $('#heatmap').innerHTML = list.map((d) => heatCell(d, scale)).join('');
}

// ---------------------------------------------------------------- container (physical layout)
const locCode = (d) => (d.rack ? `S${d.rack}·L${d.shelf}·V${d.slot}` : '');
const rackOf = (id) => state.layout?.racks.find((r) => r.id === id);
const fromBottom = () => (state.layout?.shelfNumbering ?? 'bottom') === 'bottom';
/** Shelf number shown in visual row v (1 = top row on screen, as in reality). */
const shelfAtRow = (rack, v) => (fromBottom() ? rack.shelves - v + 1 : v);
/** "(apačia)" / "(viršus)" hint for the extreme shelves. */
function shelfHint(rack, shelf) {
  const lowest = fromBottom() ? 1 : rack.shelves;
  const highest = fromBottom() ? rack.shelves : 1;
  return shelf === lowest ? ' (apačia)' : shelf === highest ? ' (viršus)' : '';
}

/** Loop (rack = own pump) summary: heat load, supply temperature, summed flow estimate vs requirement. */
function rackStats(devs) {
  const live = devs.filter((d) => d.active && !isOfflineish(d) && d.latest);
  const sum = (f) => live.reduce((s, d) => s + (f(d) ?? 0), 0);
  const withWater = live.filter((d) => metricsOf(d).water_in_c != null && metricsOf(d).water_in_c > 0);
  const avg = (f) => (withWater.length ? withWater.reduce((s, d) => s + f(d), 0) / withWater.length : null);
  // Only current estimates (miners producing heat now) - summed they approximate the rack pump flow
  const flows = live.filter((d) => d.health.flow_lpm !== null).map((d) => ({ d, f: flowInfo(d) }));
  return {
    live: live.length,
    hr: sum((d) => metricsOf(d).hashrate_ths),
    heatKw: sum((d) => metricsOf(d).power_w) / 1000,
    win: avg((d) => metricsOf(d).water_in_c),
    wout: avg((d) => metricsOf(d).water_out_c),
    flowSum: flows.length ? flows.reduce((s, x) => s + x.f.v, 0) : null,
    flowReq: flows.length ? flows.reduce((s, x) => s + (x.f.req ?? 0), 0) : null,
    flowN: flows.length,
    crit: devs.filter((d) => d.active && (d.health.level === 'crit' || d.health.level === 'offline')).length,
    warn: devs.filter((d) => d.active && d.health.level === 'warn').length,
  };
}

function renderSite() {
  const layout = state.layout;
  if (!layout) return;
  const metric = HEAT_METRICS.find((x) => x.key === state.siteMetric) ?? HEAT_METRICS[0];
  $('#site-metric').innerHTML = metricButtons(metric.key);
  const placed = state.devices.filter((d) => d.rack);
  const scale = heatScale(metric, placed);
  $('#site-legend').innerHTML = scale.legend;

  $('#site-numbering').textContent = fromBottom() ? 'lentyna 1 – apačioje' : 'lentyna 1 – viršuje';
  $('#site').innerHTML = layout.racks
    .map((rack) => {
      const devs = placed.filter((d) => d.rack === rack.id);
      const st = rackStats(devs);
      const flowCls = st.flowSum !== null && st.flowReq && st.flowSum < st.flowReq ? 'crit' : '';
      let grid = '';
      for (let row = 1; row <= rack.shelves; row++) {
        const shelf = shelfAtRow(rack, row);
        for (let slot = 1; slot <= rack.slots; slot++) {
          const d = devs.find((x) => x.shelf === shelf && x.slot === slot);
          grid += d
            ? heatCell(d, scale, displayName(d))
            : `<button type="button" class="cell slot-empty" data-place="${rack.id}:${shelf}:${slot}" title="Tuščia vieta L${shelf}·V${slot} – priskirti kasyklą"><span class="n">L${shelf}·V${slot}</span><span class="v">+ priskirti</span></button>`;
        }
      }
      return `<section class="rack">
        <header class="rack-head">
          <div><b>${esc(rack.name)}</b> <span class="muted small">${devs.length}/${rack.shelves * rack.slots}</span></div>
          <div class="rack-badges">${st.crit ? `<span class="badge">${statusIcon('crit')}${st.crit}</span>` : ''}${st.warn ? `<span class="badge">${statusIcon('warn')}${st.warn}</span>` : ''}${!st.crit && !st.warn && devs.length ? `<span class="badge">${statusIcon('ok')}</span>` : ''}</div>
        </header>
        <div class="rack-stats">
          ${statBox('Hashrate', `${hrParts(st.hr).v} ${hrParts(st.hr).u}`)}
          ${statBox('Šiluma', `${nf(st.heatKw, 1)} kW`)}
          ${statBox('Kontūras in → out', st.win === null ? '–' : `${nf(st.win, 1)} → ${nf(st.wout, 1)} °C`)}
          ${statBox('Σ debitas (apsk.)', st.flowSum === null ? '–' : `<span title="${st.flowN} kasant kasyklų apskaičiuotų debitų suma (≈ siurblio debitas)">${nf(st.flowSum, 0)} / ${nf(st.flowReq, 0)} l/min</span>`, flowCls)}
        </div>
        <div class="rack-grid" style="grid-template-columns:repeat(${rack.slots}, minmax(0, 1fr))">${grid}</div>
      </section>`;
    })
    .join('');

  const unassigned = state.devices.filter((d) => !d.rack);
  $('#unassigned-count').textContent = unassigned.length;
  $('#unassigned-card').hidden = unassigned.length === 0;
  $('#unassigned').innerHTML = unassigned
    .sort(cmpIp)
    .map(
      (d) => `<div class="ua-row" data-id="${esc(d.id)}">
        ${statusIcon(d.health.level)}
        <div class="ua-name"><b>${esc(displayName(d))}</b><span class="muted small">${esc(d.ip)} · ${esc(shortModel(d.model))}${d.mac ? ` · ${esc(d.mac)}` : ''}</span></div>
        ${d.commands.includes('find') ? `<button type="button" class="btn small-btn${detailsOf(d)?.locating ? ' primary' : ''}" data-find="${esc(d.id)}">${detailsOf(d)?.locating ? '◉ Mirksi – išjungti' : '◎ Rasti (LED)'}</button>` : ''}
        <button type="button" class="btn small-btn" data-assign="${esc(d.id)}">Priskirti vietą…</button>
      </div>`,
    )
    .join('');
}

/** Placement dialog: choose device and/or location. */
function openPlaceDialog({ deviceId = null, rack = null, shelf = null, slot = null }) {
  const dlg = $('#place-dialog');
  const devSel = $('#place-device');
  const devices = [...state.devices].sort((a, b) => (a.rack ? 1 : 0) - (b.rack ? 1 : 0) || cmpIp(a, b));
  devSel.innerHTML = devices.map((d) => `<option value="${esc(d.id)}">${esc(displayName(d))} – ${esc(d.ip)}${d.rack ? ` (dabar ${locCode(d)})` : ' (nepriskirta)'}</option>`).join('');
  if (deviceId) devSel.value = deviceId;
  const rackSel = $('#place-rack');
  rackSel.innerHTML = state.layout.racks.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const d = state.devices.find((x) => x.id === devSel.value);
  rackSel.value = String(rack ?? d?.rack ?? state.layout.racks[0].id);
  const fillPos = (prefShelf, prefSlot) => {
    const r = rackOf(Number(rackSel.value));
    const taken = (sh, sl) => state.devices.find((x) => x.rack === r.id && x.shelf === sh && x.slot === sl && x.id !== devSel.value);
    $('#place-shelf').innerHTML = Array.from({ length: r.shelves }, (_, i) => `<option value="${i + 1}">Lentyna ${i + 1}${shelfHint(r, i + 1)}</option>`).join('');
    $('#place-shelf').value = String(Math.min(prefShelf ?? 1, r.shelves));
    const sh = Number($('#place-shelf').value);
    $('#place-slot').innerHTML = Array.from({ length: r.slots }, (_, i) => {
      const o = taken(sh, i + 1);
      return `<option value="${i + 1}"${o ? ' disabled' : ''}>Vieta ${i + 1}${i === 0 ? ' (kairė)' : ''}${o ? ` – užimta (${esc(displayName(o))})` : ''}</option>`;
    }).join('');
    const firstFree = [...$('#place-slot').options].find((o) => !o.disabled)?.value;
    $('#place-slot').value = String(prefSlot && !$('#place-slot').options[prefSlot - 1]?.disabled ? prefSlot : firstFree ?? 1);
  };
  // Preferred position (clicked slot / current location) or the first free one in the container
  const free = (r, sh, sl) => !state.devices.some((x) => x.rack === r && x.shelf === sh && x.slot === sl && x.id !== devSel.value);
  let pr = Number(rackSel.value), ps = shelf ?? d?.shelf ?? 1, pl = slot ?? d?.slot ?? 1;
  if (!free(pr, ps, pl)) {
    outer: for (const r of state.layout.racks) {
      for (let sh = 1; sh <= r.shelves; sh++) for (let sl = 1; sl <= r.slots; sl++) {
        if (free(r.id, sh, sl)) { pr = r.id; ps = sh; pl = sl; break outer; }
      }
    }
  }
  rackSel.value = String(pr);
  fillPos(ps, pl);
  rackSel.onchange = () => fillPos(1, null);
  $('#place-shelf').onchange = () => fillPos(Number($('#place-shelf').value), null);
  devSel.onchange = () => fillPos(Number($('#place-shelf').value), Number($('#place-slot').value));
  $('#place-clear').hidden = !d?.rack;
  dlg.showModal();
}

async function savePlacement(location) {
  const id = $('#place-device').value;
  try {
    await api(`devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { location } });
    $('#place-dialog').close();
    toast(location ? `Priskirta: S${location.rack}·L${location.shelf}·V${location.slot}` : 'Vieta pašalinta');
    await loadDevices();
  } catch (e) {
    toast(e.message, true);
  }
}

async function toggleFind(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`devices/${encodeURIComponent(id)}/commands`, { method: 'POST', body: { command: 'find' } });
    toast('LED perjungtas – būsena atsinaujins per kelias sekundes');
    setTimeout(loadDevices, 2500);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadLayout() {
  state.layout = await api('settings/layout');
}

// ---------------------------------------------------------------- events
const EVENT_LVL = { info: 'ok', warn: 'warn', error: 'crit' };
function eventRow(e) {
  const dev = state.devices.find((d) => d.id === e.device_id);
  return `<li><span class="t">${fullFmt.format(new Date(e.time))}</span>${statusIcon(EVENT_LVL[e.level] ?? 'info')}<span class="d">${esc(dev ? displayName(dev) : e.device_id ?? 'sistema')}</span><span>${e.source === 'firmware' ? '<span class="tag" title="Iš kasyklos firmware žurnalo">FW</span> ' : ''}${esc(e.message)}</span></li>`;
}
function renderEvents() {
  $('#event-log').innerHTML = state.events.map(eventRow).join('') || '<li class="muted">Įvykių nėra</li>';
}

// ---------------------------------------------------------------- drawer
const COMMAND_LT = { start: '▶ Paleisti kasimą', stop: '■ Sustabdyti kasimą', restart: 'Restart kasimo', reboot: 'Reboot sistemos', power_cycle: 'Power cycle (relė)', relay_on: 'Relė ON', relay_off: 'Relė OFF' };

const STOPPED_STATES = new Set(['stopped', 'paused']);
const isStopped = (d) => STOPPED_STATES.has(detailsOf(d)?.state ?? '');
/** Show only the start/stop button that makes sense for the current state. */
function visibleCommands(d) {
  return d.commands.filter((c) => {
    if (c === 'relay_on' || c === 'relay_off') return false;
    if (c === 'start') return isStopped(d) || isOfflineish(d);
    if (c === 'stop') return !isStopped(d);
    return true;
  });
}

const CONFIRM_LT = {
  stop: 'Sustabdyti kasimą? Kasykla nustos kasti, kol nepaleisite vėl.',
  reboot: 'Perkrauti visą kasyklos sistemą? Kasimas bus nutrauktas ~2-3 min.',
  restart: 'Perkrauti kasimą? Hashrate kelias minutes bus 0.',
  power_cycle: 'Išjungti ir vėl įjungti maitinimą per relę?',
};

const OVERHEAT_CODES = new Set(['overheat_stop', 'overheat_repeat', 'overheat_once']);

async function sendCommand(d, c, btn) {
  const overheat = d.health.issues.find((i) => OVERHEAT_CODES.has(i.code));
  const warning =
    overheat && (c === 'start' || c === 'restart' || c === 'power_cycle')
      ? `\n\n⚠ DĖMESIO: ${overheat.text}.\nPaleidus nepašalinus aušinimo priežasties (vandens debitas, oro kamštis, vožtuvai, filtras), kasykla greičiausiai vėl perkais.`
      : '';
  if (!confirm(`${CONFIRM_LT[c] ?? (COMMAND_LT[c] ?? c) + '?'}\n\n${displayName(d)} (${d.ip})${warning}`)) return false;
  if (btn) btn.disabled = true;
  try {
    await api(`devices/${encodeURIComponent(d.id)}/commands`, { method: 'POST', body: { command: c } });
    toast(`${(COMMAND_LT[c] ?? c).replace(/^[▶■] /, '')}: komanda išsiųsta – ${displayName(d)}`);
    return true;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openDrawer(id) {
  state.drawerId = id;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-backdrop').hidden = false;
  renderDrawer(true);
}
function closeDrawer() {
  state.drawerId = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').hidden = true;
  for (const el of $$('#drawer .chart')) { charts.delete(el); ro.unobserve(el); }
}

function renderDrawer(full = false) {
  const d = state.devices.find((x) => x.id === state.drawerId);
  if (!d) return closeDrawer();
  const h = d.health, m = metricsOf(d), det = detailsOf(d), t = T();
  const off = isOfflineish(d) || !d.latest;
  $('#drawer-title').innerHTML = `${esc(displayName(d))} ${badge(h)}`;
  const rk = rackOf(d.rack);
  $('#drawer-sub').innerHTML = `${d.rack ? `<b>${esc(rk?.name ?? 'Spinta ' + d.rack)} · lentyna ${d.shelf} · vieta ${d.slot}</b> · ` : '<b>vieta nepriskirta</b> · '}<a href="http://${esc(d.ip)}" target="_blank" rel="noopener">${esc(d.ip)}</a> · ${esc(d.model ?? '')} · ${esc(d.firmware ?? '')}`;

  if (full) {
    $('#drawer-body').innerHTML = `
      <div class="actions" id="d-actions"></div>
      <div class="card" id="d-issues"></div>
      <div class="d-kpis" id="d-kpis"></div>
      <div class="d-charts">
        <div class="card"><div class="card-title">Hashrate, TH/s</div><div class="chart" id="dc-hr"></div></div>
        <div class="card"><div class="card-title">Galia, W</div><div class="chart" id="dc-pw"></div></div>
        <div class="card"><div class="card-title">Lustų temperatūra max, °C</div><div class="chart" id="dc-chip"></div></div>
        <div class="card"><div class="card-title" id="dc-4-title"></div><div id="dc-4-legend"></div><div class="chart" id="dc-4"></div></div>
        <div class="card" id="dc-5-card" hidden><div class="card-title">Aušinimo debitas (apskaičiuotas), l/min</div><div class="chart" id="dc-5"></div></div>
      </div>
      <div class="card"><div class="card-title">Grandinės (hash boards)</div><div class="table-wrap" id="d-chains"></div></div>
      <div class="card"><div class="card-title">Įrenginys</div><div id="d-info"></div></div>
      <div class="card"><div class="card-title">Įvykiai</div><ul class="event-log" id="d-events"></ul></div>`;
    loadDrawerHistory(d);
  }

  const cmds = visibleCommands(d);
  $('#d-actions').innerHTML =
    cmds
      .map((c) =>
        c === 'find'
          ? `<button class="btn${det?.locating ? ' primary' : ''}" data-find="${esc(d.id)}">${det?.locating ? '◉ LED mirksi – išjungti' : '◎ Rasti (LED)'}</button>`
          : `<button class="btn${c === 'start' ? ' primary' : ''}" data-cmd="${c}">${COMMAND_LT[c] ?? c}</button>`,
      )
      .join('') +
    `<button class="btn" data-act="place">Vieta…</button><button class="btn" data-act="rename">Pervadinti</button><button class="btn" data-act="relay">Relė…</button>` +
    `<button class="btn" data-act="toggle">${d.active ? 'Išjungti stebėjimą' : 'Įjungti stebėjimą'}</button><button class="btn danger" data-act="delete">Pašalinti</button>`;

  $('#d-issues').innerHTML = h.issues.length
    ? `<div class="card-title">Būklė</div><ul class="m-issues">${h.issues.map((i) => `<li>${statusIcon(i.level)}${esc(i.text)}</li>`).join('')}</ul>`
    : `<div class="card-title">Būklė</div><div style="color:var(--good-ink)">✓ Problemų nerasta</div>`;

  const hr = hrParts(off ? null : m.hashrate_ths);
  const k = (l, v, cls = '') => statBox(l, v, cls);
  $('#d-kpis').innerHTML = [
    k('Hashrate', `${hr.v} ${hr.u}`),
    k('% nominalo', off ? '–' : `${nf(h.hashrate_pct, 1)} %`, tcls(h.hashrate_pct, t.hashrateWarnPct, t.hashrateCritPct, false)),
    k('Nominalas', det?.nominal_ths ? `${nf(det.nominal_ths, 1)} TH/s` : '–'),
    k(`Galia${det?.power_source ? ` (${POWER_SRC[det.power_source]})` : ''}`, off ? '–' : powerText(d, 'W')),
    k('Efektyvumas', off ? '–' : `${nf(m.efficiency_jth, 2)} J/TH`),
    k('Lustai max', off ? '–' : `${nf(m.temp_max_c, 0)} °C`, tcls(m.temp_max_c, t.tempWarnC, t.tempCriticalC)),
    m.water_in_c != null ? k('Vanduo in → out', off ? '–' : `${nf(m.water_in_c, 1)} → ${nf(m.water_out_c, 1)}`, tcls(m.water_out_c, t.waterOutWarnC, t.waterOutCritC)) : k('Ventiliatoriai', nf(m.fan_rpm_avg, 0)),
    m.water_in_c != null ? k('ΔT', `${nf(h.water_delta_c, 1)} °C`, tcls(h.water_delta_c, t.waterDeltaWarnC)) : '',
    m.water_in_c != null ? (() => { const f = flowInfo(d); return k(f.isLast ? 'Debitas (pask. kasant)' : 'Debitas (apskaič.)', `<span title="${esc(f.title)}">${f.v === null ? '–' : nf(f.v, 1) + ' l/min'}</span>`, f.cls); })() : '',
    m.water_in_c != null ? k('Privalomas debitas', `<span title="${esc(h.flow_required_spec ?? '')}">≥ ${nf(h.flow_required_lpm, 0)} l/min</span>`) : '',
    k('Share (OK / atm.)', `${nf(m.accepted, 0)} / ${nf(m.rejected, 0)}`, tcls(h.reject_pct, t.rejectWarnPct, t.rejectCritPct)),
    k('HW klaidos', nf(m.hw_errors, 0)),
    k('Būsena', esc(det?.state ?? (off ? 'offline' : '–'))),
    k('Kasa', off ? '–' : duration(m.uptime_s)),
  ].join('');

  $('#d-chains').innerHTML = det?.chains?.length
    ? `<table class="mini-table"><thead><tr><th>#</th><th>Būsena</th><th class="num">TH/s</th><th class="num">Idealus</th><th class="num">%</th><th class="num">W</th><th class="num">Lustai °C</th>${m.water_in_c != null ? '<th class="num">Vanduo °C</th>' : ''}</tr></thead><tbody>${det.chains
        .map((c) => {
          const cp = c.ideal_ths ? (c.hashrate_ths / c.ideal_ths) * 100 : null;
          const bad = c.state === 'failure' || c.state === 'disconnected';
          return `<tr><td>${esc(c.id)}</td><td>${bad ? statusIcon('crit') + ' ' : ''}${esc(c.state ?? '–')}</td><td class="num">${nf(c.hashrate_ths, 2)}</td><td class="num">${nf(c.ideal_ths, 2)}</td><td class="num ${cp !== null ? 'cell-' + tcls(cp, t.hashrateWarnPct, t.hashrateCritPct, false) : ''}">${nf(cp, 1)}</td><td class="num">${nf(c.power_w, 0)}</td><td class="num">${nf(c.chip_temp_max_c, 0)}</td>${m.water_in_c != null ? `<td class="num">${nf(c.water_in_c, 1)} → ${nf(c.water_out_c, 1)}</td>` : ''}</tr>`;
        })
        .join('')}</tbody></table>`
    : '<div class="muted small">Grandinių duomenų nėra</div>';

  $('#d-info').innerHTML = `<table class="mini-table"><tbody>
    <tr><th>ID</th><td>${esc(d.id)}</td></tr>
    <tr><th>MAC</th><td>${esc(d.mac ?? '–')}</td></tr>
    <tr><th>Protokolas</th><td>${esc(d.driver)} :${d.port}</td></tr>
    <tr><th>Pool</th><td>${esc(det?.pool ?? '–')}</td></tr>
    <tr><th>Relė</th><td>${d.relay ? esc(d.relay.type) : 'nesukonfigūruota'}</td></tr>
    <tr><th>Pirmą kartą rasta</th><td>${fullFmt.format(new Date(d.first_seen))}</td></tr>
    <tr><th>Paskutinį kartą matyta</th><td>${d.last_seen ? `${fullFmt.format(new Date(d.last_seen))} (${ago(d.last_seen)})` : '–'}</td></tr>
  </tbody></table>`;
}

async function loadDrawerHistory(d) {
  const t = T();
  const hours = state.range;
  try {
    const [rows, events] = await Promise.all([
      api(`devices/${encodeURIComponent(d.id)}/metrics?hours=${hours}&bucket=${Math.max(Math.ceil((hours * 3600) / 120), 15)}`),
      api(`events?limit=40&device=${encodeURIComponent(d.id)}`),
    ]);
    if (state.drawerId !== d.id) return;
    const p = (f) => rows.map((r) => [new Date(r.bucket).getTime(), f(r)]);
    const nominal = Math.max(0, ...rows.map((r) => r.nominal_ths ?? 0)) || null;
    lineChart($('#dc-hr'), {
      label: 'Hashrate', unit: 'TH/s', digits: 1, yMin: 0, height: 160,
      series: [{ name: 'Hashrate', color: 'var(--s1)', points: p((r) => r.hashrate_ths) }],
      refs: nominal ? [{ v: nominal, label: 'nominalas' }, { v: (nominal * t.hashrateWarnPct) / 100, label: `${t.hashrateWarnPct}%`, color: 'var(--warn)' }] : [],
    });
    lineChart($('#dc-pw'), { label: 'Galia', unit: 'W', digits: 0, yMin: 0, height: 160, series: [{ name: 'Galia', color: 'var(--s1)', points: p((r) => r.power_w) }] });
    lineChart($('#dc-chip'), {
      label: 'Lustų temperatūra', unit: '°C', digits: 1, height: 160,
      series: [{ name: 'Lustai max', color: 'var(--s1)', points: p((r) => r.temp_max_c) }],
      refs: [{ v: t.tempWarnC, label: `įspėjimas ${t.tempWarnC}°`, color: 'var(--warn)' }, { v: t.tempCriticalC, label: `kritinė ${t.tempCriticalC}°`, color: 'var(--crit)' }],
    });
    const hasWater = rows.some((r) => r.water_in_c !== null);
    if (hasWater) {
      const req = d.health.flow_required_lpm;
      $('#dc-5-card').hidden = false;
      lineChart($('#dc-5'), {
        label: 'Aušinimo debitas', unit: 'l/min', digits: 1, yMin: 0, height: 160,
        series: [{ name: 'Debitas', color: 'var(--s1)', points: p((r) => r.coolant_flow_lpm) }],
        refs: req ? [{ v: req, label: `privalomas ≥ ${req} l/min`, color: 'var(--crit)' }] : [],
      });
      $('#dc-4-title').textContent = 'Aušinimo vanduo, °C';
      $('#dc-4-legend').innerHTML = `<div class="legend"><span><i style="background:var(--s1)"></i>Įėjimas</span><span><i style="background:var(--s2)"></i>Išėjimas</span></div>`;
      lineChart($('#dc-4'), {
        label: 'Aušinimo vanduo', unit: '°C', digits: 1, height: 140,
        series: [
          { name: 'Įėjimas', color: 'var(--s1)', points: p((r) => r.water_in_c) },
          { name: 'Išėjimas', color: 'var(--s2)', points: p((r) => r.water_out_c) },
        ],
        refs: [{ v: t.waterOutWarnC, label: `out ${t.waterOutWarnC}°`, color: 'var(--warn)' }],
      });
    } else {
      $('#dc-4-title').textContent = 'Pasiekiamumas, %';
      $('#dc-4-legend').innerHTML = '';
      lineChart($('#dc-4'), { label: 'Pasiekiamumas', unit: '%', digits: 0, yMin: 0, yMax: 100, height: 160, series: [{ name: 'Online', color: 'var(--s1)', points: p((r) => r.uptime_ratio * 100) }] });
    }
    $('#d-events').innerHTML = events.map(eventRow).join('') || '<li class="muted">Įvykių nėra</li>';
  } catch (e) {
    reportBackgroundError('Istorijos klaida', e);
  }
}

async function deviceAction(btn) {
  const d = state.devices.find((x) => x.id === state.drawerId);
  if (!d) return;
  const id = encodeURIComponent(d.id);
  try {
    if (btn.dataset.act === 'place') {
      openPlaceDialog({ deviceId: d.id });
      return;
    } else if (btn.dataset.cmd) {
      if (!(await sendCommand(d, btn.dataset.cmd, btn))) return;
    } else if (btn.dataset.act === 'rename') {
      const name = prompt('Kasyklos pavadinimas (tuščia = automatinis):', d.name ?? '');
      if (name === null) return;
      await api(`devices/${id}`, { method: 'PATCH', body: { name } });
    } else if (btn.dataset.act === 'toggle') {
      await api(`devices/${id}`, { method: 'PATCH', body: { active: !d.active } });
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`Pašalinti ${displayName(d)} (${d.ip})? Istoriniai duomenys DB liks.`)) return;
      await api(`devices/${id}`, { method: 'DELETE' });
      closeDrawer();
    } else if (btn.dataset.act === 'relay') {
      $('#relay-json').value = d.relay ? JSON.stringify(d.relay, null, 2) : '';
      $('#relay-dialog').showModal();
      return;
    }
    await loadDevices();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- discovery
function renderScan(s) {
  const running = s?.state === 'running';
  $('#scan-start').disabled = running;
  $('#scan-cancel').hidden = !running;
  if (!s) return;
  $('#scan-progress').hidden = false;
  const pct = s.total ? Math.round((s.scanned / s.total) * 100) : 0;
  $('#scan-bar').style.width = `${pct}%`;
  const found = Array.isArray(s.found) ? s.found.length : s.found;
  const label = { running: 'Skenuojama', done: 'Baigta', cancelled: 'Atšaukta', error: 'Klaida' }[s.state] ?? 'Skenuojama';
  $('#scan-text').textContent = `${label}: ${s.scanned}/${s.total} adresų (${pct} %), rasta kasyklų: ${found}`;
}
function addFound(f) {
  const li = document.createElement('li');
  li.innerHTML = `${esc(f.ip)}:${f.port} — ${esc(f.model ?? '?')} <span class="muted">(${esc(f.driver)}, ${esc(f.mac ?? f.id)})</span>${f.isNew ? '<span class="tag">NAUJA</span>' : ''}`;
  $('#scan-found').appendChild(li);
}

// ---------------------------------------------------------------- settings (coolant)
const COOLANT_LT = { water: 'Vanduo', ethylene_glycol: 'Etilenglikolis', propylene_glycol: 'Propilenglikolis' };
let settingsDirty = false;

function readCoolantForm() {
  const f = $('#coolant-form');
  return {
    type: f.querySelector('input[name="type"]:checked')?.value ?? 'water',
    glycolPct: Number($('#glycol-pct').value),
    cpOverride: Number($('#cp-override').value) || 0,
    densityOverride: Number($('#density-override').value) || 0,
    requiredLpm: Number($('#req-lpm').value) || 0,
    defaultRequiredLpm: Number($('#req-default').value) || 0,
  };
}

function fillCoolantForm(s) {
  const radio = $(`#coolant-form input[name="type"][value="${s.type}"]`);
  if (radio) radio.checked = true;
  $('#glycol-pct').value = s.glycolPct;
  $('#cp-override').value = s.cpOverride || '';
  $('#density-override').value = s.densityOverride || '';
  $('#req-lpm').value = s.requiredLpm || '';
  $('#req-default').value = s.defaultRequiredLpm;
  syncCoolantUi();
}

function syncCoolantUi() {
  const v = readCoolantForm();
  $('#pct-out').textContent = `${v.glycolPct} %`;
  $('#pct-field').classList.toggle('disabled', v.type === 'water');
}

async function loadSettings() {
  try {
    state.settings = await api('settings');
    settingsDirty = false;
    fillCoolantForm(state.settings.coolant);
    const d = state.settings.defaults;
    $('#coolant-source').textContent = `Numatytieji (konfigūracija): ${COOLANT_LT[d.type] ?? d.type}${d.type !== 'water' ? ` ${d.glycolPct} %` : ''}. Dashboard'e išsaugoti nustatymai turi pirmenybę.`;
    await previewCoolant();
  } catch (e) {
    reportBackgroundError('Nustatymų klaida', e);
  }
}

let previewTimer;
function schedulePreview() {
  settingsDirty = true;
  syncCoolantUi();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewCoolant, 200);
}

/** Shows derived cp/ρ and how each hydro miner's flow estimate would change (flow ∝ 1/(cp·ρ)). */
async function previewCoolant() {
  try {
    const next = await api('settings/coolant/preview', { method: 'POST', body: readCoolantForm() });
    const cur = state.settings?.derived ?? state.info?.coolant;
    const factor = cur ? (cur.cpJkgK * cur.densityKgL) / (next.cpJkgK * next.densityKgL) : 1;
    const req = readCoolantForm();
    const rows = state.devices
      .filter((d) => d.capabilities?.includes('water_in_c'))
      .map((d) => {
        const f = flowInfo(d);
        const nv = f.v === null ? null : f.v * factor;
        const need = req.requiredLpm > 0 ? req.requiredLpm : f.req;
        const bad = nv !== null && need && nv < need;
        return `<tr><td>${esc(displayName(d))}</td><td class="num">${nf(f.v, 1)}</td><td class="num"><b>${nf(nv, 1)}</b></td><td class="num">${nf(need, 0)}</td><td>${nv === null ? '–' : bad ? `${statusIcon('crit')} per mažas` : `${statusIcon('ok')} pakankamas`}</td></tr>`;
      })
      .join('');
    $('#coolant-preview').innerHTML = `
      <div class="preview-props">
        ${statBox('Šiluminė talpa', `${nf(next.cpJkgK, 0)} J/(kg·K)`)}
        ${statBox('Tankis', `${nf(next.densityKgL, 3)} kg/l`)}
      </div>
      <p>Debito įverčiai keisis <b>${factor >= 1 ? '+' : ''}${nf((factor - 1) * 100, 1)} %</b> (dabar: ${esc(cur?.label ?? '?')}).</p>
      ${rows ? `<table class="preview-table"><thead><tr><th>Kasykla</th><th class="num">Dabar</th><th class="num">Bus</th><th class="num">Privaloma</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Hydro kasyklų su debito duomenimis dar nėra.</p>'}`;
  } catch (e) {
    $('#coolant-preview').textContent = e.message;
  }
}

async function saveCoolant(ev) {
  ev.preventDefault();
  const btn = $('#coolant-save');
  btn.disabled = true;
  try {
    const res = await api('settings/coolant', { method: 'PUT', body: readCoolantForm() });
    state.settings = res;
    settingsDirty = false;
    toast(`Išsaugota: ${res.derived.label}${res.recalculated ? ` · perskaičiuota ${res.recalculated} istorinių reikšmių` : ''}`);
    await Promise.all([loadInfo(), loadDevices()]);
    await previewCoolant();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function resetCoolant() {
  if (!confirm('Atstatyti aušinimo nustatymus į numatytuosius (iš konfigūracijos)?')) return;
  try {
    const res = await api('settings/coolant', { method: 'DELETE' });
    state.settings = res;
    fillCoolantForm(res.coolant);
    toast(`Atstatyta: ${res.derived.label}`);
    await Promise.all([loadInfo(), loadDevices()]);
    await previewCoolant();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- settings (container layout)
function renderLayoutEditor() {
  const l = state.layout;
  if (!l) return;
  $('#layout-site').value = l.siteName;
  $('#layout-numbering').value = l.shelfNumbering ?? 'bottom';
  $('#layout-racks').innerHTML = l.racks
    .map(
      (r, i) => `<tr>
        <td>${i + 1}</td>
        <td><input data-k="name" value="${esc(r.name)}" maxlength="40" /></td>
        <td><input data-k="shelves" type="number" min="1" max="12" value="${r.shelves}" /></td>
        <td><input data-k="slots" type="number" min="1" max="12" value="${r.slots}" /></td>
        <td class="muted small">${state.devices.filter((d) => d.rack === r.id).length}/${r.shelves * r.slots}</td>
        <td><button type="button" class="icon-btn" data-remove="${i}" title="Pašalinti spintą" aria-label="Pašalinti spintą">✕</button></td>
      </tr>`,
    )
    .join('');
}

function readLayoutEditor() {
  return {
    siteName: $('#layout-site').value,
    shelfNumbering: $('#layout-numbering').value,
    racks: $$('#layout-racks tr').map((tr) => ({
      name: tr.querySelector('[data-k="name"]').value,
      shelves: Number(tr.querySelector('[data-k="shelves"]').value),
      slots: Number(tr.querySelector('[data-k="slots"]').value),
    })),
  };
}

async function saveLayout() {
  try {
    state.layout = await api('settings/layout', { method: 'PUT', body: readLayoutEditor() });
    renderLayoutEditor();
    toast('Išdėstymas išsaugotas');
    renderAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- render orchestration
function renderAll() {
  renderKpis();
  renderChips();
  if (state.tab === 'overview') { renderAttention(); renderGrid(); }
  if (state.tab === 'table') renderTable();
  if (state.tab === 'heatmap') renderHeatmap();
  if (state.tab === 'site') renderSite();
  if (state.drawerId) renderDrawer(false);
}

function setTab(tab) {
  state.tab = tab;
  store.set('tab', tab);
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'events') renderEvents();
  if (tab === 'settings') { loadSettings(); renderLayoutEditor(); }
  renderAll();
}

// ---------------------------------------------------------------- data loading
async function loadDevices() {
  try {
    state.devices = await api('devices');
    renderAll();
  } catch (e) {
    reportBackgroundError('Nepavyko gauti kasyklų', e);
  }
}
async function loadFleet() {
  try {
    const [fleet, sparks] = await Promise.all([api(`fleet/history?hours=${state.range}`), api('fleet/sparklines?hours=6')]);
    state.fleet = fleet;
    state.sparks = Object.fromEntries(Object.entries(sparks).map(([k, v]) => [k, v.map(([t, val]) => [new Date(t).getTime(), val])]));
    renderFleetCharts();
    if (state.tab === 'overview') renderGrid();
  } catch (e) {
    reportBackgroundError('Istorijos klaida', e);
  }
}
async function loadInfo() {
  state.info = await api('info');
  const sel = $('#scan-driver');
  if (sel.options.length === 1) {
    for (const d of state.info.drivers) sel.add(new Option(`${d.label}`, d.name));
  }
}
async function loadEvents() {
  state.events = await api('events?limit=300');
  if (state.tab === 'events') renderEvents();
}

/** Full reload after the connection comes back. */
function refreshAll() {
  loadInfo().catch(() => {});
  loadDevices();
  loadFleet();
  loadEvents().catch(() => {});
  const d = state.devices.find((x) => x.id === state.drawerId);
  if (d) loadDrawerHistory(d);
}

// ---------------------------------------------------------------- live updates (SSE)
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadDevices, 300); };

function connectStream() {
  const es = new EventSource('api/stream');
  const on = (type, fn) => es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
  on('hello', (d) => {
    if (d.scan) { renderScan(d.scan); $('#scan-found').innerHTML = ''; d.scan.found.forEach(addFound); }
    if (state.info) state.info.lastCycle = d.lastCycle;
  });
  on('scan.started', renderScan);
  on('scan.progress', (p) => renderScan({ ...p, state: 'running' }));
  on('scan.found', (f) => { addFound(f); scheduleRefresh(); });
  on('scan.finished', (s) => { renderScan(s); toast(`Skenavimas baigtas: rasta ${s.found.length} kasyklų`); scheduleRefresh(); });
  on('poll.cycle', (c) => { if (state.info) state.info.lastCycle = c; loadDevices(); });
  on('device.changed', scheduleRefresh);
  on('settings.changed', () => {
    loadInfo().catch(() => {});
    loadLayout().then(renderAll).catch(() => {});
    if (state.tab === 'settings' && !settingsDirty) loadSettings();
  });
  on('event.log', (e) => {
    state.events.unshift(e);
    state.events.length = Math.min(state.events.length, 300);
    if (state.tab === 'events') renderEvents();
  });
  es.onerror = () => api('info').then((i) => { state.info = i; renderKpis(); }).catch(() => {});
}

// ---------------------------------------------------------------- wiring
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function wire() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#theme-toggle').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
    renderAll();
    for (const [el, o] of charts) drawChart(el, o);
  });
  $('#kpis').addEventListener('click', (e) => {
    if (!e.target.closest('.kpi-link')) return;
    state.statusFilter = 'notmining';
    if (state.tab !== 'overview' && state.tab !== 'table' && state.tab !== 'heatmap') setTab('overview');
    renderAll();
    $('#status-chips').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderAll(); });
  $('#status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.statusFilter = state.statusFilter === b.dataset.filter ? 'all' : b.dataset.filter;
    renderAll();
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); renderAll(); });
  $('#range').addEventListener('change', (e) => {
    state.range = Number(e.target.value);
    store.set('range', state.range);
    loadFleet();
    const d = state.devices.find((x) => x.id === state.drawerId);
    if (d) loadDrawerHistory(d);
  });

  // open drawer from cards / attention / table / heatmap (click + keyboard)
  const opener = (sel) => (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button')) return; // buttons inside cards handle themselves
    const el = e.target.closest(sel);
    if (!el?.dataset.id) return;
    e.preventDefault();
    openDrawer(el.dataset.id);
  };
  // Quick action buttons inside cards must not open the drawer
  $('#miner-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-quick]');
    if (!b) return;
    e.stopPropagation();
    const d = state.devices.find((x) => x.id === b.closest('.miner').dataset.id);
    try {
      if (d && (await sendCommand(d, b.dataset.quick, b))) setTimeout(loadDevices, 1500);
    } catch (err) {
      toast(err.message, true);
    }
  }, true);
  for (const [root, sel] of [['#site', '.cell'], ['#miner-grid', '.miner'], ['#attention-list', 'li'], ['#table-body', 'tr'], ['#heatmap', '.cell']]) {
    $(root).addEventListener('click', opener(sel));
    $(root).addEventListener('keydown', opener(sel));
  }
  $('#table-head').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.dataset.key;
    state.tableSort = { key, dir: state.tableSort.key === key ? -state.tableSort.dir : 1 };
    renderTable();
  });
  $('#site-metric').addEventListener('click', (e) => {
    const b = e.target.closest('[data-metric]');
    if (!b) return;
    state.siteMetric = b.dataset.metric;
    store.set('siteMetric', state.siteMetric);
    renderSite();
  });
  $('#site').addEventListener('click', (e) => {
    const empty = e.target.closest('[data-place]');
    if (!empty) return;
    const [rack, shelf, slot] = empty.dataset.place.split(':').map(Number);
    const firstUnassigned = state.devices.filter((d) => !d.rack).sort(cmpIp)[0];
    openPlaceDialog({ deviceId: firstUnassigned?.id ?? null, rack, shelf, slot });
  });
  $('#unassigned').addEventListener('click', (e) => {
    const f = e.target.closest('[data-find]');
    if (f) return toggleFind(f.dataset.find, f);
    const a = e.target.closest('[data-assign]');
    if (a) openPlaceDialog({ deviceId: a.dataset.assign });
  });
  $('#place-form').addEventListener('submit', (ev) => {
    if (ev.submitter?.value === 'cancel') return;
    ev.preventDefault();
    if (ev.submitter?.value === 'clear') return savePlacement(null);
    savePlacement({ rack: Number($('#place-rack').value), shelf: Number($('#place-shelf').value), slot: Number($('#place-slot').value) });
  });
  $('#heat-metric').addEventListener('click', (e) => {
    const b = e.target.closest('[data-metric]');
    if (!b) return;
    state.heatMetric = b.dataset.metric;
    store.set('heatMetric', state.heatMetric);
    renderHeatmap();
  });

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.drawerId && !$('#relay-dialog').open) closeDrawer(); });
  $('#drawer-body').addEventListener('click', (e) => {
    const f = e.target.closest('button[data-find]');
    if (f) return toggleFind(f.dataset.find, f);
    const b = e.target.closest('button[data-cmd], button[data-act]');
    if (b) deviceAction(b);
  });
  $('#relay-form').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'save') return;
    ev.preventDefault();
    const text = $('#relay-json').value.trim();
    try {
      const relay = text ? JSON.parse(text) : null;
      await api(`devices/${encodeURIComponent(state.drawerId)}`, { method: 'PATCH', body: { relay } });
      $('#relay-dialog').close();
      toast('Relė išsaugota');
      await loadDevices();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#scan-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const range = $('#scan-range').value.trim();
    store.set('scanRange', range);
    $('#scan-found').innerHTML = '';
    try {
      const port = $('#scan-port').value;
      renderScan(await api('scan', { method: 'POST', body: { range, driver: $('#scan-driver').value, port: port || undefined } }));
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#layout-add').addEventListener('click', () => {
    const cur = readLayoutEditor();
    const last = cur.racks[cur.racks.length - 1] ?? { shelves: 4, slots: 4 };
    cur.racks.push({ name: `Spinta ${cur.racks.length + 1}`, shelves: last.shelves, slots: last.slots });
    state.layout = { ...cur, racks: cur.racks.map((r, i) => ({ ...r, id: i + 1 })) };
    renderLayoutEditor();
  });
  $('#layout-racks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const cur = readLayoutEditor();
    cur.racks.splice(Number(b.dataset.remove), 1);
    state.layout = { ...cur, racks: cur.racks.map((r, i) => ({ ...r, id: i + 1 })) };
    renderLayoutEditor();
  });
  $('#layout-save').addEventListener('click', saveLayout);
  $('#coolant-form').addEventListener('input', schedulePreview);
  $('#coolant-form').addEventListener('submit', saveCoolant);
  $('#coolant-reset').addEventListener('click', resetCoolant);
  $('#coolant-unknown').addEventListener('click', () => {
    $('#coolant-form input[name="type"][value="ethylene_glycol"]').checked = true;
    $('#glycol-pct').value = 30;
    schedulePreview();
  });
  $$('.quick-pcts button').forEach((b) =>
    b.addEventListener('click', () => {
      $('#glycol-pct').value = b.dataset.pct;
      if ($('#coolant-form input[name="type"][value="water"]').checked) $('#coolant-form input[name="type"][value="ethylene_glycol"]').checked = true;
      schedulePreview();
    }),
  );
  $('#scan-cancel').addEventListener('click', () => api('scan', { method: 'DELETE' }).catch((e) => toast(e.message, true)));
}

(async function init() {
  applyTheme(store.get('theme', null));
  state.sort = store.get('sort', 'health');
  state.range = store.get('range', 24);
  state.heatMetric = store.get('heatMetric', 'health');
  state.siteMetric = store.get('siteMetric', 'health');
  $('#sort').value = state.sort;
  $('#range').value = String(state.range);
  $('#scan-range').value = store.get('scanRange', '');
  wire();
  try { await Promise.all([loadInfo(), loadLayout()]); } catch (e) { reportBackgroundError('API klaida', e); }
  setTab(store.get('tab', 'overview'));
  await loadDevices();
  loadFleet();
  loadEvents().catch(() => {});
  connectStream();
  setInterval(loadFleet, 60_000);
  setInterval(() => api('info').then((i) => { state.info = i; renderKpis(); }).catch(() => {}), 15_000);
})();
