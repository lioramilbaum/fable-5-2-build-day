import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapterPlayable, gameInstruction, parseGame } from '../lib/game.js';
import { CREDITS, emptyLedger, award, scoreGame, shuffled } from '../public/game-logic.js';

const bites = Array.from({ length: 7 }, (_, i) => ({
  chapter: i < 3 ? 0 : i < 6 ? 1 : 3,
  words: 10,
  section: null,
  blocks: [{ type: 'p', text: `Bite ${i + 1} text.`, indent: 0 }],
}));

const manual = {
  id: 'm1',
  title: 'Test Manual',
  chapters: [
    { title: 'Setup', start: 0, end: 2, front: false },
    { title: 'Using the timer', start: 3, end: 5, front: false },
    { title: 'Contents', start: 0, end: 0, front: true },
    { title: 'Short', start: 6, end: 6, front: false },
  ],
  bites,
};

const validReply = {
  quiz: [
    { question: 'What does the timer do?', options: ['Counts down', 'Plays music', 'Locks the door'], answer: 0, quote: 'The timer counts down.', bite: 2 },
    { question: 'Which key saves?', options: ['Esc', 'Tab', 'Ctrl S'], answer: 2, quote: 'Press Ctrl S.', bite: 3 },
    { question: 'What comes first?', options: ['Plug in', 'Turn on', 'Unbox'], answer: 1, quote: 'Turn on the unit.', bite: 1 },
  ],
  truefalse: [
    { statement: 'The timer counts down.', answer: true, quote: 'The timer counts down.', bite: 2 },
    { statement: 'The timer plays music.', answer: false, quote: 'The timer counts down.', bite: 2 },
    { statement: 'Ctrl S saves.', answer: true, quote: 'Press Ctrl S.', bite: 3 },
    { statement: 'Esc saves.', answer: false, quote: 'Press Ctrl S.', bite: 3 },
    { statement: 'You turn on the unit first.', answer: true, quote: 'Turn on the unit.', bite: 1 },
  ],
  order: {
    prompt: 'Set up the timer.',
    steps: ['Unbox', 'Plug in', 'Turn on', 'Set time'],
    quote: 'Unbox, plug in, then turn on.',
    bite: 1,
  },
};

const text = (reply) => JSON.stringify(reply);

test('gameInstruction names the chapter, its bite range and asks for JSON only', () => {
  const out = gameInstruction(manual, 0);
  assert.ok(out.includes('Setup'));
  assert.ok(out.includes('Bites 1–3'));
  assert.match(out, /JSON/);
  assert.match(out, /nothing else/);
});

test('chapterPlayable rejects front, out-of-range and one-bite chapters', () => {
  assert.equal(chapterPlayable(manual, 2), false);
  assert.equal(chapterPlayable(manual, 9), false);
  assert.equal(chapterPlayable(manual, 3), false);
  assert.equal(chapterPlayable(manual, 0), true);
  assert.equal(chapterPlayable(manual, 1), true);
});

test('parseGame accepts a valid reply', () => {
  const result = parseGame(text(validReply), manual, 0);
  assert.equal(result.ok, true);
  assert.equal(result.game.quiz.length, 3);
  assert.equal(result.game.truefalse.length, 5);
  assert.equal(result.game.chapter, 0);
  assert.equal(result.game.title, 'Setup');
  assert.deepEqual(result.game.order.steps, validReply.order.steps);
});

test('parseGame accepts fenced JSON with a sentence before it', () => {
  const fenced = 'Here is your game:\n```json\n' + text(validReply) + '\n```';
  assert.equal(parseGame(fenced, manual, 0).ok, true);
});

test('parseGame rejects garbage and empty text', () => {
  assert.equal(parseGame('', manual, 0).ok, false);
  assert.equal(parseGame('no json here', manual, 0).ok, false);
  assert.equal(parseGame('{not json}', manual, 0).ok, false);
  assert.equal(parseGame(undefined, manual, 0).ok, false);
});

test('parseGame rejects when only 2 quiz items are valid', () => {
  const reply = { ...validReply, quiz: [validReply.quiz[0], validReply.quiz[1], { ...validReply.quiz[2], answer: 3 }] };
  assert.equal(parseGame(text(reply), manual, 0).ok, false);
});

test('parseGame drops quiz items with 4 options, duplicate options or a bad answer', () => {
  const reply = {
    ...validReply,
    quiz: [
      { ...validReply.quiz[0], options: ['A', 'B', 'C', 'D'] },
      { ...validReply.quiz[0], options: ['A', 'A', 'C'] },
      { ...validReply.quiz[1], answer: 3 },
      ...validReply.quiz,
    ],
  };
  const result = parseGame(text(reply), manual, 0);
  assert.equal(result.ok, true);
  assert.equal(result.game.quiz.length, 3);
  assert.deepEqual(result.game.quiz[0].options, validReply.quiz[0].options);
  result.game.quiz.forEach((q) => assert.equal(q.options.length, 3));
});

test('parseGame rejects when only 4 true or false items are valid', () => {
  const reply = { ...validReply, truefalse: validReply.truefalse.slice(0, 4) };
  assert.equal(parseGame(text(reply), manual, 0).ok, false);
});

test('parseGame drops true or false items with a non-boolean answer', () => {
  const reply = {
    ...validReply,
    truefalse: [{ statement: 'Bad', answer: 'yes' }, ...validReply.truefalse],
  };
  const result = parseGame(text(reply), manual, 0);
  assert.equal(result.ok, true);
  assert.equal(result.game.truefalse.length, 5);
  result.game.truefalse.forEach((s) => assert.equal(typeof s.answer, 'boolean'));
});

test('parseGame sets order to null for 3 steps or duplicate steps but stays ok', () => {
  const three = parseGame(text({ ...validReply, order: { ...validReply.order, steps: ['a', 'b', 'c'] } }), manual, 0);
  assert.equal(three.ok, true);
  assert.equal(three.game.order, null);
  const dup = parseGame(text({ ...validReply, order: { ...validReply.order, steps: ['a', 'a', 'b', 'c'] } }), manual, 0);
  assert.equal(dup.ok, true);
  assert.equal(dup.game.order, null);
});

test('parseGame accepts order: null', () => {
  const result = parseGame(text({ ...validReply, order: null }), manual, 0);
  assert.equal(result.ok, true);
  assert.equal(result.game.order, null);
});

test('parseGame replaces a bite outside the chapter with its first bite', () => {
  const reply = { ...validReply, quiz: validReply.quiz.map((q) => ({ ...q, bite: 99 })) };
  const result = parseGame(text(reply), manual, 0);
  assert.equal(result.ok, true);
  result.game.quiz.forEach((q) => assert.equal(q.bite, 1));
});

test('parseGame cuts a long quote to 300 characters', () => {
  const reply = { ...validReply, quiz: validReply.quiz.map((q) => ({ ...q, quote: 'a'.repeat(500) })) };
  const result = parseGame(text(reply), manual, 0);
  assert.equal(result.game.quiz[0].quote.length, 300);
});

const game = {
  chapter: 0,
  title: 'Test Manual',
  quiz: [{ answer: 0 }, { answer: 2 }, { answer: 1 }],
  truefalse: [{ answer: true }, { answer: false }, { answer: true }, { answer: true }, { answer: false }],
  order: { prompt: 'p', steps: ['a', 'b', 'c', 'd'], quote: '', bite: 1 },
};

test('scoreGame scores quiz, truefalse and order by position', () => {
  assert.deepEqual(scoreGame('quiz', game, [0, 2, 0]), { correct: 2, total: 3, perfect: false });
  assert.deepEqual(scoreGame('quiz', game, [0, 2, 1]), { correct: 3, total: 3, perfect: true });
  assert.deepEqual(scoreGame('truefalse', game, [true, false, true, false, false]), { correct: 4, total: 5, perfect: false });
  assert.deepEqual(scoreGame('order', game, ['a', 'b', 'd', 'c']), { correct: 2, total: 4, perfect: false });
  assert.deepEqual(scoreGame('order', game, ['a', 'b', 'c', 'd']), { correct: 4, total: 4, perfect: true });
});

test('award pays the chapter credit once', () => {
  const first = award(emptyLedger(), { manualId: 'm1', chapter: 0, kind: 'chapter', correct: 0, total: 0 });
  assert.equal(first.earned, CREDITS.chapter);
  assert.equal(first.ledger.balance, CREDITS.chapter);
  const again = award(first.ledger, { manualId: 'm1', chapter: 0, kind: 'chapter', correct: 0, total: 0 });
  assert.equal(again.earned, 0);
  assert.equal(again.ledger.balance, CREDITS.chapter);
});

test('award pays per correct answer, with the perfect bonus', () => {
  const two = award(emptyLedger(), { manualId: 'm1', chapter: 0, kind: 'quiz', correct: 2, total: 3 });
  assert.equal(two.earned, 20);
  const three = award(emptyLedger(), { manualId: 'm1', chapter: 0, kind: 'quiz', correct: 3, total: 3 });
  assert.equal(three.earned, 40);
  const zero = award(emptyLedger(), { manualId: 'm1', chapter: 0, kind: 'quiz', correct: 0, total: 3 });
  assert.equal(zero.earned, 0);
});

test('award does not pay a replay and does not mutate the input ledger', () => {
  const ledger = emptyLedger();
  const before = JSON.stringify(ledger);
  const paid = award(ledger, { manualId: 'm1', chapter: 0, kind: 'quiz', correct: 3, total: 3 });
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(paid.ledger.balance, 40);
  const replay = award(paid.ledger, { manualId: 'm1', chapter: 0, kind: 'quiz', correct: 3, total: 3 });
  assert.equal(replay.earned, 0);
  assert.equal(replay.ledger.balance, 40);
});

test('award pays different chapters and kinds separately', () => {
  let ledger = emptyLedger();
  const steps = [
    { chapter: 0, kind: 'quiz' },
    { chapter: 0, kind: 'truefalse' },
    { chapter: 1, kind: 'quiz' },
  ];
  for (const s of steps) {
    const r = award(ledger, { manualId: 'm1', ...s, correct: 1, total: 3 });
    assert.equal(r.earned, 10);
    ledger = r.ledger;
  }
  assert.equal(ledger.balance, 30);
  assert.equal(ledger.history.length, 3);
});

test('shuffled returns a permutation that differs from the original order', () => {
  const steps = ['one', 'two', 'three', 'four'];
  const out = shuffled(steps);
  assert.deepEqual([...out].sort(), [...steps].sort());
  assert.notDeepEqual(out, steps);
});

test('shuffled is deterministic for the same seed', () => {
  const steps = ['one', 'two', 'three', 'four'];
  assert.deepEqual(shuffled(steps, 7), shuffled(steps, 7));
  assert.deepEqual(steps, ['one', 'two', 'three', 'four']);
});
