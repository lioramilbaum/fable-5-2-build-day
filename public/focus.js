// Pure attention logic for Drift. No DOM access, no imports.

export const DEFAULT_SPRINT = 4;

const clampLevel = (level) => Math.min(4, Math.max(1, level));

export function expectedMs(words, wpm) {
  return (words / wpm) * 60000;
}

export function calibratedWpm(samples) {
  const plausible = [];
  for (const { words, ms } of samples) {
    if (!(ms > 0)) continue;
    const wpm = (words / ms) * 60000;
    if (wpm >= 80 && wpm <= 600) plausible.push(wpm);
  }
  if (plausible.length < 5) return 200;
  plausible.sort((a, b) => a - b);
  const mid = Math.floor(plausible.length / 2);
  const median =
    plausible.length % 2 === 1
      ? plausible[mid]
      : (plausible[mid - 1] + plausible[mid]) / 2;
  return Math.min(600, Math.max(80, median));
}

export function thresholds(level) {
  const l = clampLevel(level);
  return {
    stalledFactor: 3 + 1.5 * (l - 1),
    stalledFloorMs: 45000 + 30000 * (l - 1),
    skimCount: 3 + (l - 1),
    skimFactor: Math.max(0.1, 0.35 - 0.08 * (l - 1)),
    returnedMs: 60000 * l,
  };
}

export function driftSignal({
  now,
  biteShownAt,
  lastInputAt,
  words,
  wpm,
  recent,
  hiddenMs,
  levels,
  lastOfferAt,
}) {
  if (lastOfferAt != null && now - lastOfferAt < 120000) return null;

  const lv = levels || {};
  const levelOf = (key) => lv[key] ?? 1;

  const returned = thresholds(levelOf('returned'));
  if (hiddenMs >= returned.returnedMs) return 'returned';

  const stalled = thresholds(levelOf('stalled'));
  const idle = now - Math.max(biteShownAt ?? 0, lastInputAt ?? 0);
  const stalledLimit = Math.max(
    stalled.stalledFactor * expectedMs(words, wpm),
    stalled.stalledFloorMs,
  );
  if (idle > stalledLimit) return 'stalled';

  const skim = thresholds(levelOf('skimming'));
  const entries = recent || [];
  if (entries.length >= skim.skimCount) {
    const last = entries.slice(-skim.skimCount);
    const allFast = last.every(
      (e) => e.ms < skim.skimFactor * expectedMs(e.words, wpm),
    );
    if (allFast) return 'skimming';
  }

  return null;
}

export function isSprintEnd(sprintStartPos, len, pos) {
  return pos - sprintStartPos >= len;
}

export function nextSprintLength(len, hadDrift) {
  const next = hadDrift ? len - 1 : len + 1;
  return Math.min(10, Math.max(2, next));
}

export function addReading(stats, todayKey, sessionMs, deltaMs) {
  const sameDay = stats != null && stats.day === todayKey;
  const base = sameDay ? (stats.todayMs ?? 0) : 0;
  return {
    day: todayKey,
    todayMs: base + deltaMs,
    longestMs: Math.max(stats?.longestMs ?? 0, sessionMs),
  };
}

export function fmtMinutes(ms) {
  if (ms < 60000) return 'less than a minute';
  return `${Math.floor(ms / 60000)} min`;
}
