// Microphone -> AnalyserNode. Call startMic() from a tap.
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
    close() {
      stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
