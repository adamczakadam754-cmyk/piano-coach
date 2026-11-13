// Draws falling notes and the keyboard onto a <canvas>.
import { isBlack, noteName } from './notes.js';

const COLOR = {
  bg: '#14161c', lane: '#232733', upcoming: '#3b82f6', current: '#facc15', hit: '#22c55e',
  wrong: '#ef4444', heard: '#a78bfa', white: '#f4f4f5', black: '#18181b', edge: '#52525b', dark: '#0b0c10',
};
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

  function draw({ follower, viewBeat, frame, wrong, now }) {
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
    const step = follower && !follower.done ? song.steps[follower.index] : null;

    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLOR.lane;
    for (let m = lo; m <= hi; m += 12) ctx.fillRect(keys.get(m).x * kw, 0, dpr, top);
    ctx.textAlign = 'center';

    if (follower) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, top);
      ctx.clip();
      ctx.font = `600 ${Math.round(Math.min(kw * 0.4, 15 * dpr))}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      for (let i = Math.max(0, follower.index - 2); i < song.steps.length; i++) {
        const s = song.steps[i];
        const bottom = top - (s.t - viewBeat) * ppb;
        if (bottom < 0) break; // steps are in time order: the rest are off-screen
        const h = Math.max(s.d * ppb - 4 * dpr, 6 * dpr);
        for (const n of s.notes) {
          const k = keys.get(n);
          const fill = i < follower.index || (i === follower.index && follower.hit.has(n)) ? COLOR.hit
            : i === follower.index ? COLOR.current : COLOR.upcoming;
          ctx.globalAlpha = i < follower.index ? 0.35 : 1;
          ctx.fillStyle = fill;
          ctx.fillRect(k.x * kw + 2 * dpr, bottom - h, k.w * kw - 4 * dpr, h);
          if (h > 20 * dpr) {
            ctx.fillStyle = fill === COLOR.upcoming ? COLOR.white : COLOR.dark;
            ctx.fillText(noteName(n), (k.x + k.w / 2) * kw, bottom - 4 * dpr);
          }
        }
      }
      ctx.restore();
    }

    const colorFor = (m, base) => {
      if (wrong && wrong.note === m && now < wrong.until) return COLOR.wrong;
      if (step && step.notes.includes(m)) return follower.hit.has(m) ? COLOR.hit : COLOR.current;
      if (frame && frame.heard.includes(m)) return COLOR.heard;
      return base;
    };
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

    if (!song) { // mic check: show the note big
      ctx.fillStyle = COLOR.white;
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(top * 0.3)}px system-ui, sans-serif`;
      ctx.fillText(frame?.best != null ? noteName(frame.best) : '…', W / 2, top * 0.45);
      ctx.font = `${Math.round(16 * dpr)}px system-ui, sans-serif`;
      ctx.fillStyle = COLOR.edge;
      ctx.fillText('Play single keys and check the name matches', W / 2, top * 0.8);
    }
  }

  return { draw };
}
