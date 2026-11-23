import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedMs,
  calibratedWpm,
  thresholds,
  driftSignal,
  isSprintEnd,
  nextSprintLength,
  addReading,
  fmtMinutes,
  DEFAULT_SPRINT,
} from '../public/focus.js';

// Base scenario: 100 words at 200 wpm => expectedMs = 30000.
const base = {
  now: 1_000_000,
  biteShownAt: 1_000_000,
  lastInputAt: 1_000_000,
  words: 100,
  wpm: 200,
  recent: [],
  hiddenMs: 0,
  levels: { returned: 1, stalled: 1, skimming: 1 },
  lastOfferAt: null,
};

const fast = (n) => Array.from({ length: n }, () => ({ words: 100, ms: 5000 }));
const normal = { words: 100, ms: 30000 };

test('expectedMs converts words at wpm to milliseconds', () => {
  assert.equal(expectedMs(100, 200), 30000);
});

test('driftSignal: normal pacing returns null', () => {
  assert.equal(driftSignal({ ...base, recent: [normal, normal, normal] }), null);
});

test('driftSignal: stalled fires only past max(3 x expected, 45 s) at 200 wpm', () => {
  // limit = max(90000, 45000) = 90000
  const at = (idle) =>
    driftSignal({ ...base, now: base.now, biteShownAt: base.now - idle, lastInputAt: base.now - idle });
  assert.equal(at(89_000), null);
  assert.equal(at(90_000), null);
  assert.equal(at(90_001), 'stalled');
});

test('driftSignal: stalled uses the 45 s floor for short bites', () => {
  // 10 words at 200 wpm => expected 3000, 3x = 9000, floor 45000 wins.
  const args = { ...base, words: 10, biteShownAt: base.now - 44_000, lastInputAt: base.now - 44_000 };
  assert.equal(driftSignal(args), null);
  assert.equal(driftSignal({ ...args, biteShownAt: base.now - 46_000, lastInputAt: base.now - 46_000 }), 'stalled');
});

test('driftSignal: stalled measures from the latest of biteShownAt and lastInputAt', () => {
  const args = { ...base, biteShownAt: base.now - 100_000, lastInputAt: base.now - 10_000 };
  assert.equal(driftSignal(args), null);
});

test('driftSignal: skimming fires after 3 consecutive fast bites', () => {
  // expected per 100 words at 200 wpm = 30000; skimFactor 0.35 => fast if ms < 10500
  assert.equal(driftSignal({ ...base, recent: fast(3) }), 'skimming');
});

test('driftSignal: skimming does not fire after only 2 fast bites', () => {
  assert.equal(driftSignal({ ...base, recent: fast(2) }), null);
});

test('driftSignal: skimming does not fire when a normal bite is among the last 3', () => {
  assert.equal(driftSignal({ ...base, recent: [fast(1)[0], normal, fast(1)[0], fast(1)[0]] }), null);
  assert.equal(driftSignal({ ...base, recent: [normal, normal, fast(1)[0], fast(1)[0]] }), null);
  assert.equal(driftSignal({ ...base, recent: [fast(1)[0], normal, ...fast(3)] }), 'skimming');
});

test('driftSignal: returned fires when hidden for at least 60 s', () => {
  assert.equal(driftSignal({ ...base, hiddenMs: 59_999 }), null);
  assert.equal(driftSignal({ ...base, hiddenMs: 60_000 }), 'returned');
});

test('driftSignal: higher levels need more extreme timings', () => {
  // returned level 2 => 120 s
  assert.equal(driftSignal({ ...base, hiddenMs: 60_000, levels: { returned: 2 } }), null);
  assert.equal(driftSignal({ ...base, hiddenMs: 120_000, levels: { returned: 2 } }), 'returned');

  // stalled level 2 => max(4.5 x 30000, 75000) = 135000
  const idle = (ms) => ({ ...base, biteShownAt: base.now - ms, lastInputAt: base.now - ms });
  assert.equal(driftSignal({ ...idle(100_000), levels: { stalled: 2 } }), null);
  assert.equal(driftSignal({ ...idle(136_000), levels: { stalled: 2 } }), 'stalled');

  // skimming level 2 => needs 4 fast bites
  assert.equal(driftSignal({ ...base, recent: fast(3), levels: { skimming: 2 } }), null);
  assert.equal(driftSignal({ ...base, recent: fast(4), levels: { skimming: 2 } }), 'skimming');
});

test('driftSignal: a cooldown of 120 s suppresses every signal', () => {
  const offer = base.now - 119_000;
  const suppressed = {
    ...base,
    lastOfferAt: offer,
    hiddenMs: 999_999,
    biteShownAt: base.now - 999_999,
    lastInputAt: base.now - 999_999,
    recent: fast(3),
  };
  assert.equal(driftSignal(suppressed), null);
  assert.equal(driftSignal({ ...suppressed, lastOfferAt: base.now - 120_000 }), 'returned');
});

test('driftSignal: priority is returned > stalled > skimming', () => {
  const everything = {
    ...base,
    hiddenMs: 60_000,
    biteShownAt: base.now - 999_999,
    lastInputAt: base.now - 999_999,
    recent: fast(3),
  };
  assert.equal(driftSignal(everything), 'returned');
  assert.equal(driftSignal({ ...everything, hiddenMs: 0 }), 'stalled');
  assert.equal(driftSignal({ ...everything, hiddenMs: 0, biteShownAt: base.now, lastInputAt: base.now }), 'skimming');
});

test('calibratedWpm: returns 200 with fewer than 5 plausible samples', () => {
  assert.equal(calibratedWpm([]), 200);
  assert.equal(calibratedWpm([{ words: 100, ms: 30000 }, { words: 100, ms: 30000 }, { words: 100, ms: 30000 }, { words: 100, ms: 30000 }]), 200);
});

test('calibratedWpm: returns the median of 5 plausible samples', () => {
  // wpm values: 100, 150, 200, 250, 300 => median 200
  const samples = [
    { words: 100, ms: 60000 },
    { words: 150, ms: 60000 },
    { words: 200, ms: 60000 },
    { words: 250, ms: 60000 },
    { words: 300, ms: 60000 },
  ];
  assert.equal(calibratedWpm(samples), 200);
  assert.equal(calibratedWpm(samples.slice(0, 4).concat({ words: 400, ms: 60000 })), 200);
});

test('calibratedWpm: ignores implausible samples', () => {
  const plausible = [
    { words: 100, ms: 60000 },
    { words: 120, ms: 60000 },
    { words: 140, ms: 60000 },
    { words: 160, ms: 60000 },
    { words: 180, ms: 60000 },
  ];
  // 1 wpm and 10000 wpm are implausible and must not move the median.
  const noisy = [...plausible, { words: 1, ms: 60000 }, { words: 10_000, ms: 60000 }];
  assert.equal(calibratedWpm(noisy), 140);
  // Too few plausible samples: still 200.
  assert.equal(calibratedWpm([{ words: 1, ms: 60000 }, ...plausible.slice(0, 4)]), 200);
});

test('calibratedWpm: median of plausible samples stays within 80..600', () => {
  // Plausible samples all near 590 wpm => median 590 (in range).
  const high = Array.from({ length: 5 }, () => ({ words: 590, ms: 60000 }));
  assert.equal(calibratedWpm(high), 590);
  const over = Array.from({ length: 5 }, () => ({ words: 599, ms: 60000 }));
  assert.equal(calibratedWpm(over), 599);
});

test('thresholds: clamps level and computes per-level values', () => {
  assert.deepEqual(thresholds(1), {
    stalledFactor: 3,
    stalledFloorMs: 45000,
    skimCount: 3,
    skimFactor: 0.35,
    returnedMs: 60000,
  });
  assert.deepEqual(thresholds(0), thresholds(1));
  assert.deepEqual(thresholds(9), thresholds(4));
  const l4 = thresholds(4);
  assert.equal(l4.stalledFactor, 7.5);
  assert.equal(l4.stalledFloorMs, 135000);
  assert.equal(l4.skimCount, 6);
  assert.ok(Math.abs(l4.skimFactor - 0.11) < 1e-9);
  assert.equal(l4.returnedMs, 240000);
});

test('isSprintEnd: boundaries', () => {
  assert.equal(isSprintEnd(10, 4, 13), false);
  assert.equal(isSprintEnd(10, 4, 14), true);
  assert.equal(isSprintEnd(10, 4, 15), true);
});

test('nextSprintLength: grows without drift and shrinks with drift, within 2..10', () => {
  assert.equal(nextSprintLength(DEFAULT_SPRINT, false), 5);
  assert.equal(nextSprintLength(DEFAULT_SPRINT, true), 3);
  assert.equal(nextSprintLength(10, false), 10);
  assert.equal(nextSprintLength(2, true), 2);
  assert.equal(DEFAULT_SPRINT, 4);
});

test('addReading: resets todayMs on a new day', () => {
  const prev = { day: '2026-11-22', todayMs: 500_000, longestMs: 900_000 };
  const next = addReading(prev, '2026-11-23', 60_000, 30_000);
  assert.deepEqual(next, { day: '2026-11-23', todayMs: 30_000, longestMs: 900_000 });
});

test('addReading: accumulates on the same day and tracks the longest session', () => {
  const prev = { day: '2026-11-23', todayMs: 500_000, longestMs: 100_000 };
  const next = addReading(prev, '2026-11-23', 250_000, 30_000);
  assert.deepEqual(next, { day: '2026-11-23', todayMs: 530_000, longestMs: 250_000 });
});

test('addReading: handles null stats and does not mutate its input', () => {
  assert.deepEqual(addReading(null, '2026-11-23', 10_000, 10_000), {
    day: '2026-11-23',
    todayMs: 10_000,
    longestMs: 10_000,
  });
  const prev = { day: '2026-11-23', todayMs: 5, longestMs: 5 };
  const snapshot = { ...prev };
  const next = addReading(prev, '2026-11-23', 100, 10);
  assert.notEqual(next, prev);
  assert.deepEqual(prev, snapshot);
});

test('fmtMinutes: formats 0, 59999, 60000 and 7.5 minutes', () => {
  assert.equal(fmtMinutes(0), 'less than a minute');
  assert.equal(fmtMinutes(59_999), 'less than a minute');
  assert.equal(fmtMinutes(60_000), '1 min');
  assert.equal(fmtMinutes(7.5 * 60_000), '7 min');
});
