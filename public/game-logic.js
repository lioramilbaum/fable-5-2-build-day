// Pure game rules: scoring, credits and shuffling. No DOM access.

export const CREDITS = Object.freeze({ chapter: 5, correct: 10, perfect: 10 });

export function emptyLedger() {
  return { balance: 0, paid: {}, history: [] };
}

export function scoreGame(kind, game, answers = []) {
  const given = Array.isArray(answers) ? answers : [];
  let correct = 0;
  let total = 0;
  if (kind === 'quiz') {
    total = game.quiz.length;
    game.quiz.forEach((q, i) => {
      if (given[i] === q.answer) correct += 1;
    });
  } else if (kind === 'truefalse') {
    total = game.truefalse.length;
    game.truefalse.forEach((s, i) => {
      if (given[i] === s.answer) correct += 1;
    });
  } else if (kind === 'order') {
    const steps = game.order ? game.order.steps : [];
    total = steps.length;
    steps.forEach((step, i) => {
      if (given[i] === step) correct += 1;
    });
  }
  return { correct, total, perfect: total > 0 && correct === total };
}

export function award(ledger, { manualId, chapter, kind, correct, total }) {
  const key = `${manualId}:${chapter}:${kind}`;
  const paid = ledger.paid || {};
  if (paid[key]) return { ledger, earned: 0 };

  let earned = 0;
  if (kind === 'chapter') {
    earned = CREDITS.chapter;
  } else {
    earned = Math.max(0, correct * CREDITS.correct);
    if (correct === total && total > 0) earned += CREDITS.perfect;
  }

  const next = {
    balance: ledger.balance + earned,
    paid: { ...paid, [key]: true },
    history: [...(ledger.history || []), { key, earned, at: new Date().toISOString() }],
  };
  return { ledger: next, earned };
}

// Small seeded PRNG (mulberry32) so the same seed always gives the same order.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(steps, seed = 1) {
  const original = [...steps];
  const distinct = new Set(original).size >= 2;
  const rand = mulberry32(seed);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const arr = [...original];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (!distinct || arr.some((s, i) => s !== original[i])) return arr;
  }
  // Rotating by one always differs when there are two or more distinct steps.
  return [...original.slice(1), original[0]];
}
