// Steadies what the screen shows. Detection is re-run ~60 times a second and a decaying piano note
// can drop in and out between frames; the display must not flicker along with it.
//  - a key lights up once its note has been heard for showAfterMs (single-frame blips never show),
//  - stays lit holdMs after the note was last heard (bridges dropouts as the note decays),
//  - the "Hearing" name only changes when another note has been the loudest for switchMs.
export function createDisplaySmoother({ showAfterMs = 60, holdMs = 350, gapMs = 120, switchMs = 150 } = {}) {
  const runs = new Map(); // note -> { first, last }: current run of being heard (short gaps bridged)
  let best = { note: null, since: 0 };
  let shown = null;

  return {
    update(frame, now) {
      for (const m of frame?.heard ?? []) {
        const r = runs.get(m);
        if (r && now - r.last <= gapMs) r.last = now;
        else runs.set(m, { first: now, last: now });
      }
      const lit = [];
      for (const [m, r] of runs) {
        if (now - r.last > holdMs) runs.delete(m);
        else if (r.last - r.first >= showAfterMs) lit.push(m);
      }
      lit.sort((a, b) => a - b);

      const b = frame?.best ?? null;
      if (b !== best.note) best = { note: b, since: now };
      if (shown !== null && !lit.includes(shown)) shown = null;
      if (best.note !== null && best.note !== shown && lit.includes(best.note)
          && (shown === null || now - best.since >= switchMs)) {
        shown = best.note;
      }
      return { lit, shown };
    },
  };
}
