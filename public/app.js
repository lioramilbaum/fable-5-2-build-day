import {
  DEFAULT_SPRINT,
  expectedMs,
  calibratedWpm,
  driftSignal,
  isSprintEnd,
  nextSprintLength,
  addReading,
  fmtMinutes,
} from './focus.js';

// Optional modules: if either is missing, games and credits are switched off.
async function optionalImport(path) {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

const [logic, gameUI] = await Promise.all([
  optionalImport('./game-logic.js'),
  optionalImport('./game.js'),
]);
const gamesOn = Boolean(logic && gameUI);

const $ = (id) => document.getElementById(id);

const OFFER_TEXT = {
  stalled: 'Still with this bite? If your mind wandered, I can catch you up.',
  skimming: 'Moving fast. Want a three-sentence catch-up of the last few bites?',
  returned: 'Welcome back. Want a quick reminder of where you were?',
};
const OFFER_RANGE = { stalled: 3, returned: 5, skimming: 5 };

const state = {
  manual: null,
  manualId: null,
  pos: 0,
  view: 'reader',
  samples: [],
  recent: [],
  biteShownAt: Date.now(),
  lastInputAt: Date.now(),
  hiddenMs: 0,
  hiddenSince: null,
  levels: { returned: 1, stalled: 1, skimming: 1 },
  lastOfferAt: null,
  offerSig: null,
  sprintStart: 0,
  sprintLen: DEFAULT_SPRINT,
  sprintDrift: false,
  sessionMs: 0,
  sessionLastTick: 0,
  stats: loadJson('drift:stats', null),
  ledger: null,
  games: new Map(),
  cp: null,
  cpToken: 0,
  gameChapter: null,
  breakTimer: null,
};

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function announce(text) {
  $('sr-live').textContent = text;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function todayKey() {
  return new Date().toLocaleDateString('en-CA');
}

function currentStats() {
  const s = state.stats;
  if (s && s.day === todayKey()) return s;
  return { day: todayKey(), todayMs: 0, longestMs: s?.longestMs ?? 0 };
}

function updateSessionLine() {
  const s = currentStats();
  $('session').textContent =
    `Reading for ${fmtMinutes(state.sessionMs)} · Today ${fmtMinutes(s.todayMs)} · Longest ${fmtMinutes(s.longestMs)}`;
}

function updateCredits() {
  $('credits').textContent = `Credits: ${state.ledger?.balance ?? 0}`;
}

function saveLedger() {
  try {
    localStorage.setItem('drift:credits', JSON.stringify(state.ledger));
  } catch {
    /* storage full or blocked: credits still work for this visit */
  }
}

function showView(name) {
  state.view = name;
  $('reader').hidden = name !== 'reader';
  $('checkpoint').hidden = name !== 'checkpoint';
  $('break').hidden = name !== 'break';
  $('game').hidden = name !== 'game';
  if (name !== 'reader') $('offer').hidden = true;
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------- Reader ----------

function startPos(manual) {
  const first = manual.chapters.find((c) => !c.front);
  return first ? first.start : 0;
}

function chapterOf(bite) {
  return state.manual.chapters[bite.chapter];
}

function wordsLeftInChapter() {
  const { bites } = state.manual;
  const chapter = chapterOf(bites[state.pos]);
  const end = chapter ? chapter.end : bites.length - 1;
  let words = 0;
  for (let i = state.pos; i <= end && i < bites.length; i++) words += bites[i].words || 0;
  return words;
}

function renderBite() {
  const { bites } = state.manual;
  const bite = bites[state.pos];
  const chapter = chapterOf(bite);
  const article = $('bite');
  article.replaceChildren();
  for (const block of bite.blocks) {
    let el;
    if (block.type === 'h') {
      el = document.createElement('h3');
    } else if (block.type === 'pre') {
      el = document.createElement('pre');
    } else {
      el = document.createElement('p');
      if (block.indent > 0) el.classList.add('indented');
    }
    el.textContent = block.text;
    article.append(el);
  }

  $('crumb').textContent = bite.section
    ? `${chapter ? chapter.title : ''} › ${bite.section}`
    : chapter ? chapter.title : '';

  const ms = expectedMs(wordsLeftInChapter(), calibratedWpm(state.samples));
  const when = ms < 60000 ? 'less than a minute' : `about ${fmtMinutes(ms)}`;
  $('readout').textContent =
    `Bite ${state.pos + 1} of ${bites.length} · ${when} to the end of this chapter`;

  $('chapter').value = String(bite.chapter);

  if (gamesOn && chapter && !chapter.front && chapter.end - state.pos <= 3) {
    fetchGame(bite.chapter);
  }
}

function savePos() {
  try {
    localStorage.setItem(`drift:pos:${state.manualId}`, String(state.pos));
    localStorage.setItem('drift:last', state.manualId);
  } catch {
    /* ignore */
  }
}

function hiddenTotal(now) {
  return state.hiddenMs + (state.hiddenSince ? now - state.hiddenSince : 0);
}

function moveTo(pos, { focus = false } = {}) {
  const last = state.manual.bites.length - 1;
  state.pos = Math.min(last, Math.max(0, pos));
  const now = Date.now();
  state.biteShownAt = now;
  state.hiddenMs = 0;
  if (state.hiddenSince) state.hiddenSince = now;
  renderBite();
  savePos();
  $('offer').hidden = true;
  const bite = $('bite');
  if (focus) bite.focus({ preventScroll: true });
  bite.scrollIntoView({ block: 'start' });
}

function recordSample(bite) {
  const now = Date.now();
  const ms = now - state.biteShownAt - hiddenTotal(now);
  if (ms > 0 && ms <= 120000) {
    state.samples.push({ words: bite.words, ms });
    if (state.samples.length > 200) state.samples.shift();
    state.recent.push({ words: bite.words, ms });
    if (state.recent.length > 10) state.recent.shift();
  }
}

// Reading forward skips front matter (licence, indexes). Returns bites.length if none is left.
function skipFront(pos) {
  const { bites, chapters } = state.manual;
  let p = pos;
  while (p < bites.length && chapters[bites[p].chapter]?.front) p += 1;
  return p;
}

function endOfManual() {
  const text = "You've reached the end of the manual.";
  $('readout').textContent = text;
  announce(text);
}

function next({ focus = false } = {}) {
  if (!state.manual || state.view !== 'reader') return;
  const { bites } = state.manual;
  const bite = bites[state.pos];
  const chapter = chapterOf(bite);
  if (state.pos + 1 >= bites.length) {
    endOfManual();
    return;
  }
  recordSample(bite);
  if (chapter && !chapter.front && state.pos === chapter.end) {
    showChapterCheckpoint(bite.chapter);
    return;
  }
  const target = skipFront(state.pos + 1);
  if (target >= bites.length) {
    endOfManual();
    return;
  }
  if (isSprintEnd(state.sprintStart, state.sprintLen, target)) {
    showSprintCheckpoint(bite);
    return;
  }
  moveTo(target, { focus });
}

function back({ focus = false } = {}) {
  if (!state.manual || state.view !== 'reader' || state.pos === 0) return;
  if (state.pos - 1 < state.sprintStart) state.sprintStart = state.pos - 1;
  moveTo(state.pos - 1, { focus });
}

function jumpToBite(n) {
  if (!state.manual) return;
  state.cp = null;
  showView('reader');
  state.sprintStart = Math.min(Math.max(0, n - 1), state.manual.bites.length - 1);
  state.sprintDrift = false;
  moveTo(n - 1, { focus: true });
}

// ---------- Checkpoints, break, chapter complete ----------

function showSprintCheckpoint(bite) {
  const chapter = chapterOf(bite);
  const count = state.pos - state.sprintStart + 1;
  const left = chapter ? Math.max(0, chapter.end - state.pos) : 0;
  state.cp = { kind: 'sprint', chapter: bite.chapter, token: ++state.cpToken };
  $('cp-title').textContent = 'Time for a checkpoint';
  $('cp-summary').textContent =
    `${plural(count, 'bite')} · reading for ${fmtMinutes(state.sessionMs)} this session · ${plural(left, 'bite')} left in this chapter`;
  $('cp-credit').textContent = '';
  $('cp-games').hidden = true;
  showView('checkpoint');
  $('cp-keep').focus();
}

function showChapterCheckpoint(chapterIdx) {
  const chapter = state.manual.chapters[chapterIdx];
  const token = ++state.cpToken;
  state.cp = { kind: 'chapter', chapter: chapterIdx, token, game: null };
  $('cp-title').textContent = `Chapter complete: ${chapter.title}`;
  $('cp-summary').textContent = 'You have read to the end of this chapter.';

  let credit = '';
  if (gamesOn) {
    const { ledger, earned } = logic.award(state.ledger, {
      manualId: state.manualId,
      chapter: chapterIdx,
      kind: 'chapter',
    });
    state.ledger = ledger;
    saveLedger();
    updateCredits();
    if (earned > 0) credit = `+${earned} credits for finishing the chapter`;
  }
  $('cp-credit').textContent = credit;
  announce(`Chapter complete: ${chapter.title}.${credit ? ` ${credit}.` : ''}`);

  const area = $('cp-games');
  area.hidden = !gamesOn;
  if (gamesOn) {
    $('cp-games-status').hidden = false;
    $('cp-games-status').textContent = 'Your games are being prepared…';
    for (const id of ['cp-quiz', 'cp-tf', 'cp-order']) $(id).hidden = true;
    fetchGame(chapterIdx).then((game) => {
      if (!state.cp || state.cp.token !== token) return;
      if (!game) {
        area.hidden = true;
        return;
      }
      state.cp.game = game;
      $('cp-games-status').hidden = true;
      $('cp-quiz').hidden = false;
      $('cp-tf').hidden = false;
      $('cp-order').hidden = !game.order;
      announce('Games ready');
    });
  }

  showView('checkpoint');
  $('cp-keep').focus();
}

function keepGoing() {
  if (!state.manual) return;
  state.cp = null;
  showView('reader');
  const { bites } = state.manual;
  const target = skipFront(state.pos + 1);
  if (target < bites.length) {
    state.sprintLen = nextSprintLength(state.sprintLen, state.sprintDrift);
    state.sprintDrift = false;
    state.sprintStart = target;
    moveTo(target, { focus: true });
  } else {
    moveTo(state.pos, { focus: true });
    endOfManual();
  }
}

function startBreak() {
  state.cp = null;
  showView('break');
  $('break-running').hidden = false;
  $('break-done').hidden = true;
  let left = 60;
  $('break-count').textContent = `${left} seconds left`;
  $('break-back').focus();
  clearInterval(state.breakTimer);
  state.breakTimer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      $('break-count').textContent = `${left} seconds left`;
      return;
    }
    clearInterval(state.breakTimer);
    announce("Break's over");
    endBreak();
  }, 1000);
}

function endBreak() {
  clearInterval(state.breakTimer);
  const { bites } = state.manual;
  const bite = bites[state.pos];
  const chapter = chapterOf(bite);
  const words = bite.blocks
    .map((b) => b.text)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
  $('break-resume').textContent =
    `You were here: ${chapter ? chapter.title : ''}, Bite ${state.pos + 1} — "${words}…"`;
  $('break-running').hidden = true;
  $('break-done').hidden = false;
  $('break-keep').focus();
}

function keepReadingAfterBreak() {
  clearInterval(state.breakTimer);
  state.sprintStart = state.pos;
  state.sprintDrift = false;
  showView('reader');
  moveTo(state.pos, { focus: true });
}

// ---------- Games ----------

function fetchGame(chapter) {
  const key = `${state.manualId}:${chapter}`;
  if (!state.games.has(key)) {
    const cached = loadJson(`drift:game:${key}`, null);
    const promise = cached
      ? Promise.resolve(cached)
      : postJson('/api/game', { manualId: state.manualId, chapter })
          .then(async (res) => {
            if (!res.ok) return null;
            const data = await res.json().catch(() => null);
            const game = data?.game ?? null;
            if (game) {
              try {
                localStorage.setItem(`drift:game:${key}`, JSON.stringify(game));
              } catch {
                /* ignore */
              }
            }
            return game;
          })
          .catch(() => null);
    state.games.set(key, promise);
  }
  return state.games.get(key);
}

function openGame(kind) {
  const cp = state.cp;
  if (!cp || !cp.game || !gamesOn) return;
  state.gameChapter = cp.chapter;
  showView('game');
  const container = $('game-container');
  container.replaceChildren();
  $('game-result').textContent = '';
  $('game').focus();
  try {
    gameUI.mountGame(container, {
      game: cp.game,
      kind,
      jump: (n) => jumpToBite(n),
      onDone: (result) => finishGame(result),
    });
  } catch {
    container.textContent = 'This game could not load. Use Back to reading to continue.';
  }
}

function finishGame({ kind, correct, total }) {
  const { ledger, earned } = logic.award(state.ledger, {
    manualId: state.manualId,
    chapter: state.gameChapter,
    kind,
    correct,
    total,
  });
  state.ledger = ledger;
  saveLedger();
  updateCredits();
  const message = earned > 0
    ? `You got ${correct} of ${total}. +${earned} credits (total ${ledger.balance})`
    : 'Already earned. This one was for fun.';
  $('game-result').textContent = message;
  announce(message);
}

function backToCheckpoint() {
  $('game-container').replaceChildren();
  if (state.cp) {
    showView('checkpoint');
    $('cp-keep').focus();
  } else {
    showView('reader');
    moveTo(state.pos, { focus: true });
  }
}

// ---------- AI answers ----------

let askSeq = 0;

function setAnswerText(text) {
  $('answer-text').textContent = text;
}

function renderWithLinks(el, text) {
  el.replaceChildren();
  const total = state.manual ? state.manual.bites.length : 0;
  const re = /Bite (\d+)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    const n = Number(match[1]);
    if (match.index > last) el.append(text.slice(last, match.index));
    if (n >= 1 && n <= total) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = match[0];
      button.addEventListener('click', () => jumpToBite(n));
      el.append(button);
    } else {
      el.append(match[0]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) el.append(text.slice(last));
}

async function ask(payload, label) {
  if (!state.manual) return;
  const seq = ++askSeq;
  $('answer-heading').textContent = label;
  $('answer-back').textContent = `Back to Bite ${state.pos + 1}`;
  $('answer-stat').textContent = '';
  setAnswerText('Thinking…');
  $('answer').hidden = false;
  $('answer-heading').focus();

  let text = '';
  let finished = false;
  const fail = (message) => {
    if (seq !== askSeq || finished) return;
    finished = true;
    setAnswerText(message);
    announce(message);
  };

  let res;
  try {
    res = await postJson('/api/ask', {
      manualId: state.manualId,
      position: state.pos,
      ...payload,
    });
  } catch {
    fail('Could not reach the reader service. Check that it is still running.');
    return;
  }
  if (seq !== askSeq) return;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    fail(data.error || 'Something went wrong. Try again.');
    return;
  }
  if (!res.body) {
    fail('The answer could not be read. Try again.');
    return;
  }

  const handle = (line) => {
    if (finished || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'chunk') {
      text += msg.text ?? '';
      setAnswerText(text);
    } else if (msg.type === 'done') {
      finished = true;
      renderWithLinks($('answer-text'), text);
      const u = msg.usage ?? {};
      const cached = u.cache_read_input_tokens ?? 0;
      const tokens =
        (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
      let stat = `Read ${tokens.toLocaleString('en-US')} tokens of the manual · ${((msg.ms ?? 0) / 1000).toFixed(1)} s`;
      if (cached > 0) stat += ' · from cache';
      if (msg.note) stat += ` · ${msg.note}`;
      $('answer-stat').textContent = stat;
      announce(text);
    } else if (msg.type === 'refusal' || msg.type === 'error') {
      fail(msg.message || 'The answer was not available.');
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (seq !== askSeq) {
        reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } catch {
    fail('The answer was interrupted. Try again.');
    return;
  }
  fail('The answer stopped early. Try again.');
}

function closeAnswer() {
  $('answer').hidden = true;
  $('bite').focus();
}

// ---------- Drift dialog and offers ----------

function openDrift() {
  if (state.view !== 'reader' || !state.manual) return;
  state.sprintDrift = true;
  const dialog = $('drift');
  if (!dialog.open) dialog.showModal();
}

function showOffer(sig) {
  state.offerSig = sig;
  state.lastOfferAt = Date.now();
  state.sprintDrift = true;
  state.hiddenMs = 0;
  if (state.hiddenSince) state.hiddenSince = Date.now();
  $('offer-text').textContent = OFFER_TEXT[sig];
  $('offer').hidden = false;
  announce(OFFER_TEXT[sig]);
}

function dismissOffer() {
  const focusWasInside = $('offer').contains(document.activeElement);
  const sig = state.offerSig;
  $('offer').hidden = true;
  if (sig) state.levels[sig] = Math.min(4, state.levels[sig] + 1);
  state.offerSig = null;
  if (focusWasInside) $('bite').focus();
}

function driftTick() {
  if (state.view !== 'reader' || !state.manual) return;
  if ($('drift').open || !$('answer').hidden || !$('offer').hidden) return;
  const { bites } = state.manual;
  const now = Date.now();
  const sig = driftSignal({
    now,
    biteShownAt: state.biteShownAt,
    lastInputAt: state.lastInputAt,
    words: bites[state.pos].words,
    wpm: calibratedWpm(state.samples),
    recent: state.recent,
    hiddenMs: hiddenTotal(now),
    levels: state.levels,
    lastOfferAt: state.lastOfferAt,
  });
  if (sig) showOffer(sig);
}

// ---------- Session timer ----------

function sessionTick() {
  const now = Date.now();
  if (document.visibilityState !== 'visible') return;
  if (now - state.lastInputAt > 5 * 60000) return;
  if (state.sessionLastTick && now - state.sessionLastTick > 15 * 60000) {
    state.sessionMs = 0;
  }
  state.sessionMs += 15000;
  state.sessionLastTick = now;
  state.stats = addReading(state.stats, todayKey(), state.sessionMs, 15000);
  try {
    localStorage.setItem('drift:stats', JSON.stringify(state.stats));
  } catch {
    /* ignore */
  }
  updateSessionLine();
}

// ---------- Manual list, switching and upload ----------

function fillManualSelect(list, selectedId) {
  const select = $('manual');
  select.replaceChildren();
  for (const m of list) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.title;
    select.append(option);
  }
  if (selectedId) select.value = selectedId;
}

function fillChapterSelect() {
  const select = $('chapter');
  select.replaceChildren();
  const reading = document.createElement('optgroup');
  reading.label = 'Chapters';
  const reference = document.createElement('optgroup');
  reference.label = 'Reference';
  state.manual.chapters.forEach((c, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = c.title;
    (c.front ? reference : reading).append(option);
  });
  if (reading.children.length) select.append(reading);
  if (reference.children.length) select.append(reference);
}

async function openManual(id) {
  let manual;
  try {
    manual = await getJson(`/api/manuals/${encodeURIComponent(id)}`);
  } catch (err) {
    announce(err.message);
    $('upload-status').textContent = err.message;
    return false;
  }
  state.cp = null;
  clearInterval(state.breakTimer);
  showView('reader');
  state.manual = manual;
  state.manualId = id;
  state.samples = [];
  state.recent = [];
  state.levels = { returned: 1, stalled: 1, skimming: 1 };
  state.offerSig = null;
  state.lastOfferAt = null;
  state.sprintDrift = false;
  state.sprintLen = DEFAULT_SPRINT;
  state.hiddenMs = 0;
  state.hiddenSince = null;
  const storedPos = localStorage.getItem(`drift:pos:${id}`);
  let saved = storedPos === null ? NaN : Number(storedPos);
  if (!Number.isInteger(saved) || saved < 0 || saved >= manual.bites.length) {
    saved = startPos(manual);
  }
  state.pos = saved;
  state.sprintStart = saved;
  state.biteShownAt = Date.now();
  $('manual').value = id;
  fillChapterSelect();
  renderBite();
  savePos();
  updateCredits();
  updateSessionLine();
  $('upload-status').textContent = '';
  // Warm the server cache; the result does not matter.
  postJson('/api/warm', { manualId: id }).catch(() => {});
  return true;
}

async function refreshManualList(selectedId) {
  const list = await getJson('/api/manuals');
  fillManualSelect(list, selectedId);
  return list;
}

async function uploadManual() {
  const status = $('upload-status');
  const pasted = $('paste').value;
  const file = $('file').files[0];
  let text = pasted;
  let title = 'My manual';
  if (!pasted.trim() && file) {
    text = await file.text();
    title = file.name.replace(/\.[^.]+$/, '') || title;
  }
  if (!text.trim()) {
    status.textContent = 'Paste some text or choose a file first.';
    announce(status.textContent);
    return;
  }
  if (text.length > 1500000) {
    status.textContent = 'That manual is too long. The limit is 1,500,000 characters.';
    announce(status.textContent);
    return;
  }
  status.textContent = 'Loading…';
  try {
    const { id } = await getJson('/api/manuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
    });
    await refreshManualList(id);
    await openManual(id);
    status.textContent = 'Manual loaded.';
    announce('Manual loaded.');
  } catch (err) {
    status.textContent = err.message;
    announce(err.message);
  }
}

// ---------- Input wiring ----------

function isTypingTarget(target) {
  return target instanceof Element &&
    Boolean(target.closest('input, textarea, select, button, summary, a, [contenteditable]'));
}

document.addEventListener('keydown', (e) => {
  state.lastInputAt = Date.now();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('drift').open) return;
  if (isTypingTarget(e.target)) return;
  if (state.view !== 'reader' || !state.manual) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (e.shiftKey) back({ focus: true });
      else next({ focus: true });
      break;
    case 'ArrowRight':
    case 'PageDown':
      e.preventDefault();
      next({ focus: true });
      break;
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault();
      back({ focus: true });
      break;
    case 'd':
    case 'D':
      openDrift();
      break;
    case 'w':
    case 'W':
      e.preventDefault();
      $('term').focus();
      break;
    default:
      break;
  }
});

['pointerdown', 'input'].forEach((type) => {
  document.addEventListener(type, () => {
    state.lastInputAt = Date.now();
  }, { passive: true });
});

document.addEventListener('visibilitychange', () => {
  const now = Date.now();
  if (document.visibilityState === 'hidden') {
    state.hiddenSince = now;
  } else if (state.hiddenSince) {
    state.hiddenMs += now - state.hiddenSince;
    state.hiddenSince = null;
  }
});

document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return;
  if (!$('bite').contains(sel.anchorNode)) return;
  const text = sel.toString().trim();
  if (text) $('term').value = text.slice(0, 200);
});

$('manual').addEventListener('change', (e) => {
  openManual(e.target.value);
});

$('chapter').addEventListener('change', (e) => {
  const chapter = state.manual.chapters[Number(e.target.value)];
  if (!chapter) return;
  jumpToBite(chapter.start + 1);
});

$('load').addEventListener('click', () => {
  uploadManual().catch((err) => {
    $('upload-status').textContent = err.message;
    announce(err.message);
  });
});

$('back').addEventListener('click', () => back());
$('next').addEventListener('click', () => next());
$('drift-open').addEventListener('click', () => openDrift());
$('where').addEventListener('click', () => {
  ask({ task: 'where' }, 'Where am I?');
});

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const term = $('term').value.trim();
  if (!term) {
    announce('Select a word in the bite, or type one, then ask again.');
    $('term').focus();
    return;
  }
  ask({ task: 'what', term }, `What does "${term}" mean?`);
});

$('answer-back').addEventListener('click', () => closeAnswer());

$('offer-catch').addEventListener('click', () => {
  const sig = state.offerSig;
  $('offer').hidden = true;
  state.offerSig = null;
  const range = OFFER_RANGE[sig] ?? 5;
  ask({ task: 'drift', range }, `Catch-up: last ${range} bites`);
});
$('offer-fine').addEventListener('click', () => dismissOffer());
$('offer').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    dismissOffer();
  }
});

for (const [id, range] of [['drift-3', 3], ['drift-5', 5], ['drift-10', 10]]) {
  $(id).addEventListener('click', () => {
    $('drift').close();
    ask({ task: 'drift', range }, `Catch-up: last ${range} bites`);
  });
}
$('drift-cancel').addEventListener('click', () => $('drift').close());

$('cp-keep').addEventListener('click', () => keepGoing());
$('cp-break').addEventListener('click', () => startBreak());
$('cp-quiz').addEventListener('click', () => openGame('quiz'));
$('cp-tf').addEventListener('click', () => openGame('truefalse'));
$('cp-order').addEventListener('click', () => openGame('order'));
$('break-back').addEventListener('click', () => endBreak());
$('break-keep').addEventListener('click', () => keepReadingAfterBreak());
$('game-back').addEventListener('click', () => backToCheckpoint());

// ---------- Timers and boot ----------

setInterval(sessionTick, 15000);
setInterval(driftTick, 5000);

async function boot() {
  if (gamesOn) {
    state.ledger = loadJson('drift:credits', null) ?? logic.emptyLedger();
  } else {
    $('credits').hidden = true;
  }
  updateCredits();
  updateSessionLine();

  let list = [];
  try {
    list = await refreshManualList();
  } catch (err) {
    $('upload-status').textContent = err.message;
    announce(err.message);
    return;
  }
  const last = localStorage.getItem('drift:last');
  const id = list.some((m) => m.id === last)
    ? last
    : list.some((m) => m.id === 'sample') ? 'sample' : list[0]?.id;
  if (!id) {
    announce('No manuals yet. Load your own manual to start.');
    return;
  }
  await openManual(id);
}

boot();
