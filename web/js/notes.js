const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiToFreq = m => 440 * 2 ** ((m - 69) / 12);
export const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
export const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
