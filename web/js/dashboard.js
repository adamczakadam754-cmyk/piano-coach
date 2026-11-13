// The Progress screen: stat tiles, a 14-day minutes chart, a 12-week practice calendar and an
// accuracy trend, drawn as inline SVG. Chart colours validated for the dark surface (single-series
// blue, one-hue ordinal ramp for the calendar).
const SERIES = '#3987e5';
const RAMP = ['#184f95', '#2a78d6', '#5598e7', '#86b6ef']; // calendar: low -> high
const EMPTY = '#232838';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
const dayLabel = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

// Bar with only the top corners rounded (data end), anchored flat on the baseline.
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const step = v <= 20 ? 5 : v <= 60 ? 10 : 30;
  return Math.ceil(v / step) * step;
}

export function minutesChart(perDay, goalMin, W = 640) {
  const H = 220, L = 34, R = 8, T = 14, B = 26;
  const max = niceMax(Math.max(goalMin, ...perDay.map(d => d.min)));
  const y = v => T + (H - T - B) * (1 - v / max);
  const slot = (W - L - R) / perDay.length;
  const bw = Math.max(4, slot - 2 * 2 - 6); // 2px surface gap each side + air
  const ticks = [0, max / 2, max];
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Minutes practised per day, last 14 days">`;
  for (const t of ticks) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`;
    svg += `<text x="${L - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${t}</text>`;
  }
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(goalMin)}" y2="${y(goalMin)}" class="goal-line"/>`;
  svg += `<text x="${W - R}" y="${y(goalMin) - 5}" class="axis" text-anchor="end">goal ${goalMin} min</text>`;
  perDay.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const isToday = i === perDay.length - 1;
    svg += `<path d="${barPath(x, y(d.min), bw, y(0) - y(d.min))}" fill="${SERIES}" class="bar" style="--i:${i}"/>`;
    if (isToday || (W >= 480 ? i % 2 === 1 : i % 3 === 1)) { // fewer date labels on narrow screens
      svg += `<text x="${x + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${isToday ? 'Today' : d.date.getDate()}</text>`;
    }
    svg += `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" class="hit" data-tip="${esc(`${dayLabel(d.date)}: ${fmtMin(d.min)}`)}"/>`;
  });
  return svg + '</svg>';
}

export function calendar(heat, goalMin) {
  const cell = 14, gap = 3, top = 16, left = 26;
  const first = heat[0].date;
  const offset = (first.getDay() + 6) % 7; // weeks start on Monday
  const weeks = Math.ceil((heat.length + offset) / 7);
  const W = left + weeks * (cell + gap), H = top + 7 * (cell + gap);
  const level = m => (m <= 0 ? -1 : m < goalMin / 2 ? 0 : m < goalMin ? 1 : m < goalMin * 2 ? 2 : 3);
  // Drawn at a fixed 1.5x size (not stretched to the card), so labels stay a readable size.
  let svg = `<svg viewBox="0 0 ${W} ${H + 4}" width="${Math.round(W * 1.5)}" class="chart calendar" role="img" aria-label="Practice calendar, last 12 weeks">`;
  ['Mon', 'Wed', 'Fri'].forEach((l, i) => {
    svg += `<text x="0" y="${top + (i * 2) * (cell + gap) + cell - 3}" class="axis small">${l}</text>`;
  });
  let lastMonth = -1;
  heat.forEach((d, i) => {
    const k = i + offset;
    const col = Math.floor(k / 7), row = k % 7;
    const x = left + col * (cell + gap), yy = top + row * (cell + gap);
    if (row === 0 && d.date.getMonth() !== lastMonth) {
      lastMonth = d.date.getMonth();
      svg += `<text x="${x}" y="10" class="axis small">${d.date.toLocaleDateString(undefined, { month: 'short' })}</text>`;
    }
    const lv = level(d.min);
    svg += `<rect x="${x}" y="${yy}" width="${cell}" height="${cell}" rx="3" fill="${lv < 0 ? EMPTY : RAMP[lv]}" class="cell" data-tip="${esc(`${dayLabel(d.date)}: ${d.min > 0 ? fmtMin(d.min) : 'no practice'}`)}"/>`;
  });
  return svg + '</svg>';
}

export function calendarLegend() {
  return `<div class="legend"><span>Less</span>${[EMPTY, ...RAMP].map(c => `<i style="background:${c}"></i>`).join('')}<span>More</span></div>`;
}

export function accuracyChart(scores, W = 640) {
  if (scores.length < 2) {
    return '<p class="empty">Finish a few songs in Practice or Play along to see your accuracy trend here.</p>';
  }
  const H = 200, L = 40, R = 14, T = 14, B = 22;
  const x = i => L + ((W - L - R) * i) / (scores.length - 1);
  const y = v => T + (H - T - B) * (1 - v);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Accuracy of your last ${scores.length} scored sessions">`;
  for (const t of [0, 0.5, 1]) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`;
    svg += `<text x="${L - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${t * 100}%</text>`;
  }
  const pts = scores.map((s, i) => `${x(i)},${y(s.score)}`).join(' ');
  svg += `<polyline points="${pts}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round" class="line"/>`;
  scores.forEach((s, i) => {
    const tip = `${s.title} · ${s.mode === 'timed' ? 'Play along' : 'Practice'} · ${Math.round(s.score * 100)}% · ${new Date(s.t).toLocaleDateString()}`;
    svg += `<circle cx="${x(i)}" cy="${y(s.score)}" r="4" fill="${SERIES}" class="dot"/>`;
    svg += `<circle cx="${x(i)}" cy="${y(s.score)}" r="12" class="hit" data-tip="${esc(tip)}"/>`;
  });
  svg += `<text x="${L}" y="${H - 4}" class="axis">older</text><text x="${W - R}" y="${H - 4}" class="axis" text-anchor="end">latest</text>`;
  return svg + '</svg>';
}

function ring(fraction) {
  const r = 34, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return `<svg viewBox="0 0 84 84" class="ring" aria-hidden="true">
    <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <circle cx="42" cy="42" r="${r}" class="ring-track"/>
    <circle cx="42" cy="42" r="${r}" class="ring-fill" stroke="url(#ringGrad)" stroke-dasharray="${c}" style="--off:${c * (1 - f)};--full:${c}"/>
  </svg>`;
}

export function renderDashboard(el, summary, mot) {
  const s = summary;
  // Charts are drawn at the card's real width (not scaled), so their text stays a true 12px.
  const W = Math.max(300, Math.min(684, (el.clientWidth || 720) - 38));
  el.innerHTML = `
    <section class="card hero-card">
      <div class="flame" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1.5-.6-2.4-1.2-3.4C17 9 19 12 19 15a7 7 0 0 1-14 0c0-5 5-7 7-13z"/></svg></div>
      <div><p class="eyebrow">Today's motivation</p><h2>${esc(mot.headline)}</h2>
      <p class="tip"><strong>${esc(mot.title)}.</strong> ${esc(mot.text)}</p></div>
    </section>
    <section class="tiles">
      <div class="card tile ring-tile">${ring(s.todayMin / s.goalMin)}<div><b>${Math.round(s.todayMin)}<small>/${s.goalMin} min</small></b><span>Today</span></div></div>
      <div class="card tile"><b>${s.streak}<small> day${s.streak === 1 ? '' : 's'}</small></b><span>Current streak</span></div>
      <div class="card tile"><b>${Math.round(s.weekMin)}<small> min</small></b><span>Last 7 days</span></div>
      <div class="card tile"><b>${s.longestStreak}<small> day${s.longestStreak === 1 ? '' : 's'}</small></b><span>Longest streak</span></div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Minutes practised</h3><span class="muted">last 14 days</span></div>
      ${minutesChart(s.perDay, s.goalMin, W)}
      <details class="table-view"><summary>Show as table</summary><table>
        <tr><th>Day</th><th>Minutes</th></tr>
        ${s.perDay.map(d => `<tr><td>${esc(dayLabel(d.date))}</td><td>${Math.round(d.min)}</td></tr>`).join('')}
      </table></details>
    </section>
    <section class="card">
      <div class="card-head"><h3>Practice calendar</h3><span class="muted">last 12 weeks</span></div>
      <div class="calendar-wrap">${calendar(s.heat, s.goalMin)}</div>
      ${calendarLegend()}
    </section>
    <section class="card">
      <div class="card-head"><h3>Accuracy</h3><span class="muted">${s.scores.length ? `last ${s.scores.length} scored sessions` : ''}</span></div>
      ${accuracyChart(s.scores, W)}
    </section>
    <section class="card goal-card">
      <h3>Daily goal</h3>
      <div class="goal-options">${[5, 10, 15, 20, 30].map(g => `<button data-goal="${g}" class="chip${g === s.goalMin ? ' active' : ''}">${g} min</button>`).join('')}</div>
      <p class="muted">${fmtMin(s.totalMin)} practised in ${s.sessions} session${s.sessions === 1 ? '' : 's'} on this device.</p>
    </section>`;
}
