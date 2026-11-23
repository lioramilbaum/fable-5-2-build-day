// Chapter games: the instruction sent to the model, and parsing of its reply.
// No API call happens here; the server sends gameInstruction() with the manual.

const QUIZ_COUNT = 3;
const TRUE_FALSE_COUNT = 5;
const STEP_COUNT = 4;
const QUOTE_MAX = 300;
const DEFAULT_PROMPT = 'Put these steps in order.';

// `chapter` is an index into manual.chapters (a chapter object is also accepted).
function resolveChapter(manual, chapter) {
  if (!manual || !Array.isArray(manual.chapters)) return null;
  const found = typeof chapter === 'number' ? manual.chapters[chapter] : chapter;
  return found && typeof found === 'object' ? found : null;
}

export function chapterPlayable(manual, chapter) {
  const c = resolveChapter(manual, chapter);
  if (!c || c.front === true) return false;
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end)) return false;
  if (c.start < 0 || c.end >= (manual.bites?.length ?? 0)) return false;
  return c.end - c.start + 1 >= 2;
}

export function gameInstruction(manual, chapter) {
  const c = resolveChapter(manual, chapter);
  if (!c) return '';
  const first = c.start + 1;
  const last = c.end + 1;
  return [
    `The reader has just finished the chapter "${c.title}", which is Bites ${first}–${last}.`,
    `Make three small games about that chapter only, using only the text of Bites ${first}–${last}.`,
    'Bite numbers are the ones marked [Bite N] in the manual above.',
    '',
    'Reply with ONE JSON object and nothing else: no markdown fences, no commentary. It must have exactly these keys:',
    '- "quiz": exactly 3 items. Each has "question"; "options" (exactly 3 short strings, exactly one correct); "answer" (the index 0, 1 or 2 of the correct option); "quote"; "bite".',
    '- "truefalse": exactly 5 items. Each has "statement"; "answer" (true or false, a mix of both); "quote"; "bite".',
    '- "order": either null, or an object with "prompt" and "steps": exactly 4 short steps of a real procedure or sequence described in this chapter, listed in the correct order, plus "quote" and "bite". Use null if the chapter describes no clear sequence.',
    '',
    '"quote" is under 25 words, copied word for word from the chapter, and it supports the answer. "bite" is the Bite number the quote comes from.',
    'Ask about what the chapter tells the reader to know or do: what a command or option does, what a term means, what comes first.',
    'Keep it friendly. No trick questions and no tiny details.',
    'Vary where the correct option sits. Write in the manual\'s language.',
  ].join('\n');
}

function fail(reason) {
  return { ok: false, reason };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function allDistinctNonEmpty(list) {
  return list.every((s) => s !== '') && new Set(list).size === list.length;
}

function normalizeQuote(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, QUOTE_MAX).join('').trim();
}

function normalizeBite(value, c) {
  const first = c.start + 1;
  return Number.isInteger(value) && value >= first && value <= c.end + 1 ? value : first;
}

function extractObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseQuiz(list, c) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const question = cleanText(item.question);
    const options = Array.isArray(item.options) ? item.options.map(cleanText) : [];
    if (!question || options.length !== 3 || !allDistinctNonEmpty(options)) continue;
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 2) continue;
    out.push({
      question,
      options,
      answer: item.answer,
      quote: normalizeQuote(item.quote),
      bite: normalizeBite(item.bite, c),
    });
  }
  return out;
}

function parseTrueFalse(list, c) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const statement = cleanText(item.statement);
    if (!statement || typeof item.answer !== 'boolean') continue;
    out.push({
      statement,
      answer: item.answer,
      quote: normalizeQuote(item.quote),
      bite: normalizeBite(item.bite, c),
    });
  }
  return out;
}

function parseOrder(value, c) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const steps = Array.isArray(value.steps) ? value.steps.map(cleanText) : [];
  if (steps.length !== STEP_COUNT || !allDistinctNonEmpty(steps)) return null;
  return {
    prompt: cleanText(value.prompt) || DEFAULT_PROMPT,
    steps,
    quote: normalizeQuote(value.quote),
    bite: normalizeBite(value.bite, c),
  };
}

export function parseGame(text, manual, chapter) {
  try {
    const c = resolveChapter(manual, chapter);
    if (!c) return fail('The chapter could not be found.');
    const data = extractObject(text);
    if (!data) return fail('The reply was not a JSON object.');

    const quiz = parseQuiz(data.quiz, c);
    if (quiz.length < QUIZ_COUNT) {
      return fail(`Needed ${QUIZ_COUNT} valid quiz questions, got ${quiz.length}.`);
    }
    const truefalse = parseTrueFalse(data.truefalse, c);
    if (truefalse.length < TRUE_FALSE_COUNT) {
      return fail(`Needed ${TRUE_FALSE_COUNT} valid true or false statements, got ${truefalse.length}.`);
    }

    const index = typeof chapter === 'number' ? chapter : manual.chapters.indexOf(c);
    return {
      ok: true,
      game: {
        chapter: index,
        title: c.title,
        quiz: quiz.slice(0, QUIZ_COUNT),
        truefalse: truefalse.slice(0, TRUE_FALSE_COUNT),
        order: parseOrder(data.order, c),
      },
    };
  } catch {
    return fail('The reply could not be read.');
  }
}
