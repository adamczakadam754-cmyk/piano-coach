// Draws falling notes and the keyboard onto a <canvas>. Knows nothing about modes: the caller
// says what state each note and key is in.
import { isBlack, noteName } from './notes.js';

const COLOR = {
  bg: '#14161c', lane: '#232733', upcoming: '#3b82f6', current: '#facc15', hit: '#22c55e', good: '#2dd4bf',
  miss: '#ef4444', past: '#22c55e', wrong: '#ef4444', heard: '#a78bfa',
  white: '#f4f4f5', black: '#18181b', edge: '#52525b', dark: '#0b0c10',
};
const ALPHA = { past: 0.35, miss: 0.45 };
const BEATS_AHEAD = 5;

export function createRenderer(canvas, song) {
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

  // noteState(i, n): 'upcoming' | 'current' | 'hit' | 'good' | 'miss' | 'past'
  // keyState(m): 'current' | 'hit' | 'wrong' | null
  // banner: { text, color } shown large above the keyboard; big: mic-check note name
  function draw({ viewBeat, frame, noteState, keyState, banner, big }) {
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

    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLOR.lane;
    for (let m = lo; m <= hi; m += 12) ctx.fillRect(keys.get(m).x * kw, 0, dpr, top);
    ctx.textAlign = 'center';

    if (song) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, top);
      ctx.clip();
      ctx.font = `600 ${Math.round(Math.min(kw * 0.4, 15 * dpr))}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      for (let i = 0; i < song.steps.length; i++) {
        const s = song.steps[i];
        const bottom = top - (s.t - viewBeat) * ppb;
        if (bottom < 0) break; // steps are in time order: the rest are off-screen
        const h = Math.max(s.d * ppb - 4 * dpr, 6 * dpr);
        if (bottom - h > top) continue; // already gone below the keyboard line
        for (const n of s.notes) {
          const k = keys.get(n);
          const state = noteState(i, n);
          ctx.globalAlpha = ALPHA[state] ?? 1;
          ctx.fillStyle = COLOR[state];
          ctx.fillRect(k.x * kw + 2 * dpr, bottom - h, k.w * kw - 4 * dpr, h);
          if (h > 20 * dpr) {
            ctx.fillStyle = state === 'upcoming' ? COLOR.white : COLOR.dark;
            ctx.fillText(noteName(n), (k.x + k.w / 2) * kw, bottom - 4 * dpr);
          }
        }
      }
      ctx.restore();
    }

    const heard = new Set(frame ? frame.heard : []);
    const colorFor = (m, base) => COLOR[keyState?.(m)] ?? (heard.has(m) ? COLOR.heard : base);
    ctx.strokeStyle = COLOR.edge;
    ctx.lineWidth = dpr;
    for (const [m, k] of keys) {
      if (k.black) continue;
      ctx.fillStyle = colorFor(m, COLOR.white);
      ctx.fillRect(k.x * kw, top, kw, kbH);
      ctx.strokeRect(k.x * kw, top, kw, kbH);
    }
    for (const [m, k] of keys) {
      if (!k.black) continue;
      ctx.fillStyle = colorFor(m, COLOR.black);
      ctx.fillRect(k.x * kw, top, k.w * kw, kbH * 0.62);
    }
    ctx.fillStyle = COLOR.dark;
    ctx.textBaseline = 'bottom';
    ctx.font = `${Math.round(Math.min(kw * 0.35, 13 * dpr))}px system-ui, sans-serif`;
    for (let m = lo; m <= hi; m += 12) ctx.fillText(noteName(m), (keys.get(m).x + 0.5) * kw, H - 6 * dpr);
    ctx.fillStyle = COLOR.current;
    ctx.fillRect(0, top - 2 * dpr, W, 2 * dpr);

    ctx.textBaseline = 'middle';
    if (banner) {
      ctx.fillStyle = banner.color ?? COLOR.white;
      ctx.font = `800 ${Math.round(Math.min(top * 0.16, 72 * dpr))}px system-ui, sans-serif`;
      ctx.fillText(banner.text, W / 2, top * 0.3);
    }
    if (big !== undefined) { // mic check
      ctx.fillStyle = COLOR.white;
      ctx.font = `700 ${Math.round(top * 0.3)}px system-ui, sans-serif`;
      ctx.fillText(big ?? '…', W / 2, top * 0.45);
      ctx.font = `${Math.round(16 * dpr)}px system-ui, sans-serif`;
      ctx.fillStyle = COLOR.edge;
      ctx.fillText('Play single keys and check the name matches', W / 2, top * 0.8);
    }
  }

  return { draw };
}
