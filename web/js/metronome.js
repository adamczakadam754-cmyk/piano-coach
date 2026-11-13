// Schedules metronome clicks slightly ahead on the audio clock, locked to the song's beat grid,
// so clicks stay steady even if a frame is late. click(delaySec, accent) makes the sound.
const LOOKAHEAD_MS = 120;

export function createMetronome(click, { beatsPerBar = 4 } = {}) {
  let next = null; // next whole beat to schedule
  return {
    // beat: where we are now in beats (may be negative during a count-in); msPerBeat: tempo.
    update(beat, msPerBeat) {
      if (next === null || next < beat - 1) next = Math.ceil(beat - 1e-6);
      while ((next - beat) * msPerBeat <= LOOKAHEAD_MS) {
        click(Math.max(0, (next - beat) * msPerBeat) / 1000, ((next % beatsPerBar) + beatsPerBar) % beatsPerBar === 0);
        next++;
      }
    },
    reset() { next = null; },
  };
}
