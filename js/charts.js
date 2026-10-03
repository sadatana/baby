// SVG の折れ線グラフ（標準値の帯つき）。DOM非依存で SVG 文字列を返す
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let chartSeq = 0;

// 見やすい目盛りの間隔（1, 2, 5 × 10^n）
export function niceStep(range, target = 5) {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export function ticks(min, max, target = 5) {
  const step = niceStep(max - min, target);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * opts:
 *   label       グラフの説明（読み上げ用）
 *   xRange      [min, max]、yRange [min, max]
 *   xTick(v)    x 目盛りの表示文字列、yTick(v) 同じく y
 *   xTicks      x 目盛りの値（省略時は自動）
 *   bands       [{ lower: [[x, y]], upper: [[x, y]], cls }] 標準値の範囲
 *   refLines    [{ pts: [[x, y]], cls }] 標準値の線（平均・中央値など）
 *   series      [{ pts: [[x, y, title]], cls }] 記録した値
 */
export function lineChart(opts) {
  const W = 340;
  const H = 220;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const [x0, x1] = opts.xRange;
  const [y0, y1] = opts.yRange;
  const sx = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (y) => H - pad.b - ((y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const f = (n) => n.toFixed(1);
  const clip = `clip${(chartSeq += 1)}`;
  const path = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(sx(x))},${f(sy(y))}`).join(' ');
  const xt = opts.xTicks ?? ticks(x0, x1, 6);
  const yt = ticks(y0, y1, 5);

  const grid = yt.map((v) => `
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${f(sy(v))}" y2="${f(sy(v))}" class="grid"/>
    <text x="${pad.l - 6}" y="${f(sy(v) + 3)}" class="tick" text-anchor="end">${esc(opts.yTick ? opts.yTick(v) : v)}</text>`).join('');
  const xLabels = xt.filter((v) => v >= x0 && v <= x1).map((v) => `
    <text x="${f(sx(v))}" y="${H - 8}" class="tick" text-anchor="middle">${esc(opts.xTick ? opts.xTick(v) : v)}</text>`).join('');

  const bands = (opts.bands || []).filter((b) => b.lower.length > 1).map((b) => {
    const d = `${path(b.upper)} ${b.lower.slice().reverse().map(([x, y]) => `L${f(sx(x))},${f(sy(y))}`).join(' ')} Z`;
    return `<path d="${d}" class="${b.cls || 'band'}"/>`;
  }).join('');
  const refs = (opts.refLines || []).filter((r) => r.pts.length > 1)
    .map((r) => `<path d="${path(r.pts)}" class="${r.cls || 'ref'}"/>`).join('');
  const series = (opts.series || []).map((s) => `
    ${s.pts.length > 1 ? `<path d="${path(s.pts)}" class="${s.cls || 'line'}"/>` : ''}
    ${s.pts.map(([x, y, title]) => `
      <g class="pt" tabindex="0">
        <circle cx="${f(sx(x))}" cy="${f(sy(y))}" r="12" class="hit"/>
        <circle cx="${f(sx(x))}" cy="${f(sy(y))}" r="4" class="${s.dotCls || 'dot'}"/>
        ${title ? `<title>${esc(title)}</title>` : ''}
      </g>`).join('')}`).join('');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">
      ${grid}
      <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" class="axis"/>
      ${xLabels}
      <defs><clipPath id="${clip}"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath></defs>
      <g clip-path="url(#${clip})">${bands}${refs}</g>
      ${series}
    </svg>`;
}
