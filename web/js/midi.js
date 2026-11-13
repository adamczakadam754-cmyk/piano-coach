// Reads Standard MIDI Files in the browser and turns them into songs the app can play.
// Mirrors tools/song_tool.py's parse_midi, plus track choice and simplification for imported files.

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u8 = () => d.getUint8(p++);
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const varlen = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad length');
  };

  try {
    if (str(4) !== 'MThd') throw new Error('This is not a MIDI file.');
    const headerLen = u32();
    u16(); // format
    const trackCount = u16();
    const division = u16();
    p = 8 + headerLen;
    if (division & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which is not supported.');

    let tempo = null;
    const tracks = [];
    for (let t = 0; t < trackCount && p + 8 <= bytes.length; t++) {
      const id = str(4);
      const len = u32();
      const end = Math.min(bytes.length, p + len);
      if (id !== 'MTrk') { p = end; continue; }
      let tick = 0, status = 0, name = '';
      const notes = [];
      const channels = new Set();
      const open = new Map(); // "channel:note" -> the note still sounding, to fill in its end
      while (p < end) {
        tick += varlen();
        if (d.getUint8(p) & 0x80) status = u8();
        else if (!status) throw new Error('bad running status');
        if (status === 0xff) {                       // meta event
          const type = u8();
          const l = varlen();
          if (type === 0x51 && tempo === null && l === 3) tempo = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2);
          if (type === 0x03 && !name) for (let i = 0; i < l; i++) name += String.fromCharCode(d.getUint8(p + i));
          p += l;
          status = 0;                                // meta/sysex cancel running status
        } else if (status === 0xf0 || status === 0xf7) {
          p += varlen();
          status = 0;
        } else {
          const type = status & 0xf0;
          const a = u8();
          const b = type === 0xc0 || type === 0xd0 ? 0 : u8();
          const key = `${status & 0x0f}:${a}`;
          if ((type === 0x80 || (type === 0x90 && b === 0)) && open.has(key)) {
            open.get(key).end = tick;
            open.delete(key);
          } else if (type === 0x90 && b > 0) {
            const n = { tick, end: null, note: a, channel: status & 0x0f };
            open.get(key) && (open.get(key).end = tick); // re-struck before release
            open.set(key, n);
            notes.push(n);
            channels.add(status & 0x0f);
          }
        }
      }
      for (const n of notes) if (n.end === null || n.end <= n.tick) n.end = n.tick + division; // never released
      p = end;
      tracks.push({ name: name.trim(), notes, drums: channels.size > 0 && [...channels].every(c => c === 9) });
    }
    return { ticksPerBeat: division, tempo: tempo ?? 500000, tracks };
  } catch (err) {
    if (err instanceof RangeError || err.message === 'bad length' || err.message === 'bad running status') {
      throw new Error('This MIDI file is damaged or incomplete.');
    }
    throw err;
  }
}

// Melody extraction ("skyline"): keep a note only if no higher note is already sounding when it
// starts. Accompaniment played under a held melody note disappears; the tune stays.
// `notes` must be sorted by start, highest first within the same start.
function skyline(notes, tolerance) {
  const kept = [];
  let active = []; // kept notes still sounding
  for (const n of notes) {
    active = active.filter(a => a.end > n.tick + tolerance);
    if (active.some(a => a.note > n.note)) continue;
    const last = kept.at(-1);
    if (last && n.tick - last.tick <= tolerance) { // same (slightly ragged) chord: keep its top note
      if (n.note > last.note) {
        kept[kept.length - 1] = n;
        active = active.filter(a => a !== last);
        active.push(n);
      }
      continue;
    }
    kept.push(n);
    active.push(n);
  }
  return kept;
}

// The track a beginner most likely wants: the non-drum track with the most notes.
export function suggestTrack(midi) {
  let best = -1;
  midi.tracks.forEach((t, i) => {
    if (!t.drums && t.notes.length && (best < 0 || t.notes.length > midi.tracks[best].notes.length)) best = i;
  });
  return best;
}

export function toSong(midi, { title = 'Imported song', tracks = [suggestTrack(midi)], melodyOnly = false, maxChord = 4 } = {}) {
  const tpb = midi.ticksPerBeat;
  let starts = tracks.flatMap(i => midi.tracks[i]?.notes ?? []).filter(n => n.channel !== 9);
  if (!starts.length) throw new Error('The chosen tracks have no notes.');
  starts.sort((a, b) => a.tick - b.tick || b.note - a.note);
  if (melodyOnly) starts = skyline(starts, tpb / 16);

  const groups = []; // notes starting within 1/16 beat of each other form one chord
  for (const { tick, note } of starts) {
    let n = note; // fold into the range the detector listens to (E2-C7)
    while (n < 40) n += 12;
    while (n > 96) n -= 12;
    const g = groups.at(-1);
    if (g && tick - g.tick <= tpb / 16) g.notes.add(n);
    else groups.push({ tick, notes: new Set([n]) });
  }
  const first = groups[0].tick;
  const steps = groups.map((g, i) => {
    let notes = [...g.notes].sort((a, b) => a - b);
    if (melodyOnly) notes = [notes.at(-1)];
    else if (notes.length > maxChord) notes = [...notes.slice(0, 1), ...notes.slice(-(maxChord - 1))]; // keep bass + top
    const next = groups[i + 1]?.tick ?? g.tick + tpb;
    return {
      t: Math.round(((g.tick - first) / tpb) * 1000) / 1000,
      d: Math.round(Math.min(4, (next - g.tick) / tpb) * 1000) / 1000,
      notes,
    };
  });
  // Melody only can leave the same note repeated in one chord's place; that is fine (it is replayed).
  return { title, bpm: Math.round(60000000 / midi.tempo), steps };
}
