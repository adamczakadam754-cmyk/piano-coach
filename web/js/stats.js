// Practice history kept on this device: sessions, streaks, daily totals and a daily motivation.
const MAX_SESSIONS = 3000;

export const dayKey = date => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };

export function addSession(history, s) {
  return [...history, s].slice(-MAX_SESSIONS);
}

// Days in a row with practice, ending today; if today has nothing yet, ending yesterday
// (the streak is still alive until the day is over).
export function streakOf(days, today = new Date()) {
  let d = days.has(dayKey(today)) ? new Date(today) : addDays(today, -1);
  let n = 0;
  while (days.has(dayKey(d))) { n++; d = addDays(d, -1); }
  return n;
}

export function summarize(history, { today = new Date(), goalMin = 10 } = {}) {
  const minutesByDay = new Map();
  for (const s of history) minutesByDay.set(s.day, (minutesByDay.get(s.day) ?? 0) + s.secs / 60);
  const days = new Set(minutesByDay.keys());
  const series = n => Array.from({ length: n }, (_, i) => {
    const d = addDays(today, i - n + 1);
    return { day: dayKey(d), date: d, min: minutesByDay.get(dayKey(d)) ?? 0 };
  });
  const last7 = series(7);
  let longest = 0;
  for (const day of days) { // a run starts at a day whose previous day is empty
    if (days.has(dayKey(addDays(new Date(`${day}T12:00`), -1)))) continue;
    let n = 0, d = new Date(`${day}T12:00`);
    while (days.has(dayKey(d))) { n++; d = addDays(d, 1); }
    longest = Math.max(longest, n);
  }
  return {
    goalMin,
    todayMin: minutesByDay.get(dayKey(today)) ?? 0,
    streak: streakOf(days, today),
    longestStreak: longest,
    weekMin: last7.reduce((a, b) => a + b.min, 0),
    totalMin: [...minutesByDay.values()].reduce((a, b) => a + b, 0),
    sessions: history.length,
    perDay: series(14),
    heat: series(84),
    scores: history.filter(s => s.score !== null && s.score !== undefined).slice(-30),
  };
}

const TIPS = [
  ['Little and often', 'Ten focused minutes every day beat an hour once a week. Your fingers learn while you sleep.'],
  ['Slow is smooth', 'Play it slower than you think you need to. Speed comes free once the notes are right.'],
  ['Hands first, then together', 'Stuck on a two-hand bit? Learn each hand alone, then join them slowly.'],
  ['Listen first', 'Use Listen mode before learning a new song. Knowing how it should sound makes it easier to play.'],
  ['Mistakes are data', 'Every wrong note shows you exactly what to practise next. Loop that bar a few times.'],
  ['Warm up', 'Start with the five-finger warm-up. Loose hands play better than cold ones.'],
  ['Count out loud', 'Turn on the metronome and count along. Rhythm is half of music.'],
  ['Small wins count', 'Learn one line today. Next time it will already feel familiar.'],
  ['Relax your shoulders', 'Tension travels down to your fingers. Breathe out and drop your shoulders.'],
  ['Same time, every day', 'Tie practice to something you already do, like after dinner. Habits beat motivation.'],
  ['Play something you love', 'Find a song you really like in Discover. Enjoying it is the best practice plan.'],
  ['Curve your fingers', 'Imagine holding a small ball under your palm. Curved fingers are faster and stronger.'],
  ['End on a high', 'Finish each session with a song you can already play well. Leave wanting more.'],
  ['Record yourself', 'Listening back shows you things you miss while playing.'],
];

// The headline reacts to the person's progress; the tip changes once a day.
export function motivation(summary, today = new Date()) {
  const { streak, todayMin, goalMin, sessions } = summary;
  const left = Math.max(0, Math.ceil(goalMin - todayMin));
  let headline;
  if (sessions === 0) headline = 'Welcome! Play your first song to start your streak.';
  else if (todayMin >= goalMin) headline = `Goal reached today, nice work!${streak > 1 ? ` That's ${streak} days in a row.` : ''}`;
  else if (todayMin > 0) headline = `${left} more minute${left === 1 ? '' : 's'} to hit today's goal.`;
  else if (streak > 0) headline = `You're on a ${streak}-day streak. Play today to make it ${streak + 1}!`;
  else headline = 'A few minutes today is all it takes to start a new streak.';
  const dayNumber = Math.floor(new Date(dayKey(today) + 'T12:00').getTime() / 86400000);
  const [title, text] = TIPS[dayNumber % TIPS.length];
  return { headline, title, text };
}
