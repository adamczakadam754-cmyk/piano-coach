// Microphone -> AnalyserNode. Call startMic() from a tap.
import { midiToFreq } from './notes.js';

export async function startMic(fftSize = 8192) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('No microphone access here. Open the app from its https:// address in Safari.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    // Voice-call processing treats a piano as noise and squashes it.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  // Create the AudioContext only after the mic is open: iOS can switch the hardware sample rate
  // when capture starts, and a context made earlier keeps the old rate, which shifts every pitch.
  // Safari lets a page that is capturing start audio; if not, main.js resumes it on the next tap.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});

  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;          // 8192 -> ~5.9 Hz bins at 48 kHz, ~170 ms window
  analyser.smoothingTimeConstant = 0;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(analyser);
  analyser.connect(mute).connect(ctx.destination); // silent, but keeps Safari pulling audio through the graph

  const track = stream.getAudioTracks()[0];
  const buf = new Float32Array(analyser.frequencyBinCount);
  return {
    sampleRate: ctx.sampleRate,
    fftSize,
    read() {
      analyser.getFloatFrequencyData(buf);
      return buf;
    },
    running: () => ctx.state === 'running',
    alive: () => track.readyState === 'live', // iOS ends capture when the app is backgrounded
    resume: () => ctx.resume().catch(() => {}),
    // Metronome tick: a pure sine with no overtones, pitched a quarter-tone between piano notes
    // (1520 Hz between F#6/G6, accent 1920 Hz between A#6/B6). A note needs several harmonics,
    // so the detector can't mistake a tick for a key being played.
    click(delaySec, accent) {
      const t0 = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = accent ? 1920 : 1520;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(accent ? 0.3 : 0.18, t0 + 0.002);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
      osc.connect(env).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.06);
    },
    // A simple piano-like tone generator for Listen mode. stop() silences everything it scheduled.
    synth() {
      const out = ctx.createGain();
      out.gain.value = 0.25;
      out.connect(ctx.destination);
      return {
        play(midi, delaySec, durSec) {
          const t0 = ctx.currentTime + delaySec;
          const t1 = t0 + Math.min(2.5, durSec + 0.5);
          for (const [mult, amp, type] of [[1, 1, 'triangle'], [2, 0.3, 'sine'], [3, 0.1, 'sine']]) {
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            osc.type = type;
            osc.frequency.value = midiToFreq(midi) * mult;
            env.gain.setValueAtTime(0, t0);
            env.gain.linearRampToValueAtTime(amp, t0 + 0.005);
            env.gain.exponentialRampToValueAtTime(0.001, t1);
            osc.connect(env).connect(out);
            osc.start(t0);
            osc.stop(t1 + 0.05);
          }
        },
        stop() { out.disconnect(); },
      };
    },
    close() {
      stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
