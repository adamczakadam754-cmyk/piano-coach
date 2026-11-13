// Draws falling notes and the keyboard onto a <canvas>. Knows nothing about modes: the caller
// says what state each note and key is in. Effects: gradient note blocks, a glow on the notes to
// play now, spark bursts on hits, an animated judgement banner, a beat pulse on the hit line.
import { isBlack, noteName } from './notes.js';

const C = {
  bgTop: '#0b0d14', bgBottom: '#161a2b', lane: 'rgba(255,255,255,0.05)', laneC: 'rgba(255,255,255,0.10)',
  upcoming: ['#6366f1', '#3b82f6'], current: ['#fde047', '#f59e0b'], hit: ['#4ade80', '#16a34a'],
  good: ['#5eead4', '#0d9488'], miss: ['#f87171', '#b91c1c'], past: ['#4ade80', '#16a34a'],
  wrong: '#ef4444', heard: '#a78bfa', white: '#f5f5f7', whiteShade: '#d4d4dc', black: '#141418',
  blackShade: '#2c2c36', edge: '#3f3f4a', dark: '#0b0c10', line: '#facc15',
};
const KEY_LIT = { current: ['#fde68a', '#facc15'], hit: ['#bbf7d0', '#22c55e'], wrong: ['#fecaca', '#ef4444'], heard: ['#ddd6fe', '#a78bfa'] };
const ALPHA = { past: 0.3, miss: 0.4 };
const BEATS_AHEAD = 5;

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createRenderer(canvas, song, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext('2d');
  const notes = song ? song.steps.flatMap(s => s.notes) : [48, 83]; // mic check: C3-B5
  let lo = Math.min(...notes);
  let hi = Math.max(...notes);
  lo -= lo % 12;                 // start on a C
  hi += 11 - (hi % 12);          // end on a B
  while (hi - lo < 23) hi += 12; // at least two octaves

  // Key positions in units of one white-key width.
  const keys = new Map();
  let whites = 0;
  for (let m = lo; m <= hi; m++) {
    keys.set(m, isBlack(m) ? { x: whites - 0.3, w: 0.6, black: true } : { x: whites++, w: 1, black: false });
  }

  let particles = [];
  let geometry = { kw: 0, top: 0, dpr: 1 };

  // Spark burst rising from key m at the hit line.
  function burst(m, kind = 'hit', now = performance.now()) {
    const k = keys.get(m);
    if (!k || reducedMotion) return;
    const { kw, top, dpr } = geometry;
    const color = (C[kind] ?? C.hit)[0];
    for (let i = 0; i < 18; i++) {
      const a = Math.PI * (1.05 + Math.random() * 0.9); // upward fan
      const speed = (0.15 + Math.random() * 0.35) * dpr;
      particles.push({ x: (k.x + k.w / 2) * kw, y: top, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        born: now, life: 450 + Math.random() * 350, color, r: (1.5 + Math.random() * 2.5) * dpr });
    }
  }

  // noteState(i, n): 'upcoming' | 'current' | 'hit' | 'good' | 'miss' | 'past'
  // keyState(m): 'current' | 'hit' | 'wrong' | null;  heard: notes to show as heard (smoothed)
  // banner: { text, color, born }; big: mic-check note name; pulse: 0..1 beat flash
  function draw({ viewBeat, heard = [], noteState, keyState, banner, big, pulse = 0, now = performance.now() }) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const kw = W / whites;
    const kbH = Math.min(H * 0.3, kw * 5);
    const top = H - kbH;
    const ppb = top / BEATS_AHEAD;
    geometry = { kw, top, dpr };

    const bg = ctx.createLinearGradient(0, 0, 0, top);
    bg.addColorStop(0, C.bgTop);
    bg.addColorStop(1, C.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let m = lo; m <= hi; m++) { // lanes: a faint line at every white key, brighter at each C
      const k = keys.get(m);
      if (k.black) continue;
      ctx.fillStyle = m % 12 === 0 ? C.laneC : C.lane;
      ctx.fillRect(k.x * kw, 0, Math.max(1, dpr * 0.75), top);
    }
    ctx.textAlign = 'center';

    if (song) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, top);
      ctx.clip();
      ctx.font = `700 ${Math.round(Math.min(kw * 0.38, 14 * dpr))}px Outfit, system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      for (let i = 0; i < song.steps.length; i++) {
        const s = song.steps[i];
        const bottom = top - (s.t - viewBeat) * ppb;
        if (bottom < 0) break; // steps are in time order: the rest are off-screen
        const h = Math.max(s.d * ppb - 5 * dpr, 8 * dpr);
        if (bottom - h > top) continue; // already gone below the keyboard line
        for (const n of s.notes) {
          const k = keys.get(n);
          const state = noteState(i, n);
          const [c1, c2] = C[state];
          const x = k.x * kw + 2.5 * dpr, w = k.w * kw - 5 * dpr;
          const g = ctx.createLinearGradient(0, bottom - h, 0, bottom);
          g.addColorStop(0, c1);
          g.addColorStop(1, c2);
          ctx.globalAlpha = ALPHA[state] ?? 1;
          if (state === 'current' && !reducedMotion) {
            ctx.shadowColor = c1;
            ctx.shadowBlur = (14 + 8 * Math.sin(now / 160)) * dpr;
          }
          ctx.fillStyle = g;
          roundRect(ctx, x, bottom - h, w, h, Math.min(8 * dpr, w / 2));
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255,255,255,0.28)'; // glossy top edge
          roundRect(ctx, x + 2 * dpr, bottom - h + 2 * dpr, w - 4 * dpr, Math.min(5 * dpr, h / 3), 3 * dpr);
          ctx.fill();
          if (h > 22 * dpr && w > 14 * dpr) {
            ctx.fillStyle = state === 'upcoming' ? 'rgba(255,255,255,0.92)' : C.dark;
            ctx.fillText(noteName(n), x + w / 2, bottom - 5 * dpr);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Hit line with a glow that pulses on the beat.
    const glow = ctx.createLinearGradient(0, top - 26 * dpr, 0, top);
    glow.addColorStop(0, 'rgba(250,204,21,0)');
    glow.addColorStop(1, `rgba(250,204,21,${0.18 + 0.35 * pulse})`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, top - 26 * dpr, W, 26 * dpr);
    ctx.fillStyle = C.line;
    ctx.fillRect(0, top - 2 * dpr, W, (2 + 2 * pulse) * dpr);

    // Keyboard.
    const heardSet = new Set(heard);
    const lit = m => keyState?.(m) ?? (heardSet.has(m) ? 'heard' : null);
    for (const [m, k] of keys) {
      if (k.black) continue;
      const state = lit(m);
      const x = k.x * kw;
      const g = ctx.createLinearGradient(0, top, 0, H);
      const [a, b] = state ? KEY_LIT[state] : [C.white, C.whiteShade];
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      roundRect(ctx, x + 0.75 * dpr, top + (state ? 2 * dpr : 0), kw - 1.5 * dpr, kbH - (state ? 2 * dpr : 0), 5 * dpr);
      ctx.fill();
    }
    for (const [m, k] of keys) {
      if (!k.black) continue;
      const state = lit(m);
      const g = ctx.createLinearGradient(0, top, 0, top + kbH * 0.62);
      const [a, b] = state ? KEY_LIT[state] : [C.blackShade, C.black];
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      roundRect(ctx, k.x * kw, top - 1 * dpr, k.w * kw, kbH * 0.62, 4 * dpr);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(11,12,16,0.55)';
    ctx.textBaseline = 'bottom';
    ctx.font = `600 ${Math.round(Math.min(kw * 0.32, 12 * dpr))}px Outfit, system-ui, sans-serif`;
    for (let m = lo; m <= hi; m += 12) ctx.fillText(noteName(m), (keys.get(m).x + 0.5) * kw, H - 7 * dpr);

    // Sparks.
    particles = particles.filter(p => now - p.born < p.life);
    for (const p of particles) {
      const t = now - p.born;
      ctx.globalAlpha = 1 - t / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + p.vx * t, p.y + p.vy * t + 0.0004 * dpr * t * t, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textBaseline = 'middle';
    if (banner) { // pops in big, settles
      const age = now - (banner.born ?? now);
      const scale = reducedMotion ? 1 : 1 + 0.35 * Math.max(0, 1 - age / 180);
      ctx.save();
      ctx.translate(W / 2, top * 0.3);
      ctx.scale(scale, scale);
      ctx.fillStyle = banner.color ?? C.white;
      ctx.shadowColor = banner.color ?? C.white;
      ctx.shadowBlur = 24 * dpr;
      ctx.font = `800 ${Math.round(Math.min(top * 0.16, 76 * dpr))}px Outfit, system-ui, sans-serif`;
      ctx.fillText(banner.text, 0, 0);
      ctx.restore();
    }
    if (big !== undefined) { // mic check
      ctx.fillStyle = C.white;
      ctx.font = `800 ${Math.round(top * 0.3)}px Outfit, system-ui, sans-serif`;
      ctx.fillText(big ?? '…', W / 2, top * 0.45);
      ctx.font = `500 ${Math.round(15 * dpr)}px Outfit, system-ui, sans-serif`;
      ctx.fillStyle = '#8b8ba0';
      ctx.fillText('Play single keys and check the name matches', W / 2, top * 0.8);
    }
  }

  return { draw, burst };
}
