// A fake detector frame for tests: levels in dB, "present" at >= 10, onsets listed explicitly,
// best = loudest present note unless given.
export const frame = (levels, onsets = [], best) => {
  const heard = Object.keys(levels).map(Number).filter(m => levels[m] >= 10);
  return {
    heard,
    onsets,
    best: best ?? (heard.length ? heard.reduce((a, b) => (levels[b] > levels[a] ? b : a)) : null),
    levelOf: m => levels[m] ?? 0,
    isPresent: m => (levels[m] ?? 0) >= 10,
  };
};
