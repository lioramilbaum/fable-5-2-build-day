// Renders one chapter game (quiz, true or false, or put-in-order) into a container.
// Game text is only ever set with textContent. Styles live in game.css.
import { scoreGame, shuffled } from './game-logic.js';

let mountCount = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = 'game-button') {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

function renderQuote(parent, ctx, quote, bite) {
  if (!quote) return;
  parent.append(el('p', 'game-quote-intro', "Here's what the manual says:"));
  const block = el('blockquote', 'game-quote', quote);
  block.dir = 'auto';
  parent.append(block);
  if (ctx.jump) {
    const see = button(`See Bite ${bite}`, 'game-button game-button--secondary');
    see.addEventListener('click', () => ctx.jump(bite));
    parent.append(see);
  }
}

function finish(ctx, correct, total) {
  if (ctx.finished) return;
  ctx.finished = true;
  ctx.root.textContent = '';
  const result = el('p', 'game-result', `You got ${correct} of ${total}.`);
  result.tabIndex = -1;
  ctx.root.append(result);
  result.focus();
  ctx.onDone({ kind: ctx.kind, correct, total });
}

function renderChoice(ctx, items, index, answers) {
  const { root } = ctx;
  root.textContent = '';
  const item = items[index];
  const total = items.length;

  root.append(el('p', 'game-progress', `Question ${index + 1} of ${total}`));

  const fieldset = el('fieldset', 'game-fieldset');
  fieldset.tabIndex = -1;
  fieldset.append(el('legend', 'game-legend', item.prompt));

  const name = `${ctx.id}-q${index}`;
  const inputs = item.options.map((text, i) => {
    const label = el('label', 'game-option');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(i);
    label.append(input, el('span', 'game-option-text', text));
    fieldset.append(label);
    return input;
  });
  root.append(fieldset);

  const check = button('Check answer');
  check.disabled = true;
  fieldset.addEventListener('change', () => {
    check.disabled = false;
  });
  root.append(check);

  check.addEventListener('click', () => {
    const chosen = inputs.findIndex((input) => input.checked);
    if (chosen < 0) return;
    inputs.forEach((input) => {
      input.disabled = true;
    });
    check.remove();

    const right = chosen === item.correctIndex;
    const feedback = el('div', `game-feedback${right ? '' : ' game-feedback--wrong'}`);
    feedback.tabIndex = -1;
    feedback.append(
      el('p', 'game-verdict', right ? 'Right.' : `Not quite. The answer is: ${item.correctText}.`),
    );
    renderQuote(feedback, ctx, item.quote, item.bite);

    const isLast = index + 1 === total;
    const next = button(isLast ? 'See result' : 'Next');
    next.addEventListener('click', () => {
      answers.push(ctx.kind === 'truefalse' ? chosen === 0 : chosen);
      if (isLast) {
        const { correct, total: count } = scoreGame(ctx.kind, ctx.game, answers);
        finish(ctx, correct, count);
      } else {
        renderChoice(ctx, items, index + 1, answers);
        root.querySelector('fieldset').focus();
      }
    });
    feedback.append(next);

    root.append(feedback);
    feedback.focus();
  });
}

function renderOrder(ctx) {
  const { root, game } = ctx;
  const order = game.order;
  root.textContent = '';

  const heading = el('h2', 'game-heading', order.prompt);
  root.append(heading);
  root.append(el('p', 'game-hint', 'Use the Move up and Move down buttons to change the order.'));

  const steps = shuffled(order.steps);
  const list = el('ol', 'game-steps');
  root.append(list);

  const check = button('Check order');
  root.append(check);

  function move(from, dir) {
    const to = from + dir;
    [steps[from], steps[to]] = [steps[to], steps[from]];
    draw();
    const item = list.children[to];
    const same = item.querySelector(dir < 0 ? '.game-move-up' : '.game-move-down');
    const other = item.querySelector(dir < 0 ? '.game-move-down' : '.game-move-up');
    (same.disabled ? other : same).focus();
  }

  function draw() {
    list.textContent = '';
    steps.forEach((step, i) => {
      const li = el('li', 'game-step');
      li.append(el('span', 'game-step-text', step));
      const controls = el('div', 'game-step-controls');
      const up = button('Move up', 'game-button game-button--small game-move-up');
      up.setAttribute('aria-label', `Move "${step}" up`);
      up.disabled = i === 0;
      up.addEventListener('click', () => move(i, -1));
      const down = button('Move down', 'game-button game-button--small game-move-down');
      down.setAttribute('aria-label', `Move "${step}" down`);
      down.disabled = i === steps.length - 1;
      down.addEventListener('click', () => move(i, 1));
      controls.append(up, down);
      li.append(controls);
      list.append(li);
    });
  }

  draw();

  check.addEventListener('click', () => {
    check.remove();
    list.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });

    const { correct, total } = scoreGame('order', game, steps);
    const feedback = el('div', `game-feedback${correct === total ? '' : ' game-feedback--wrong'}`);
    feedback.tabIndex = -1;
    feedback.append(
      el(
        'p',
        'game-verdict',
        correct === total
          ? 'Right. Every step is in the right place.'
          : `Not quite. ${correct} of ${total} steps are in the right place.`,
      ),
    );

    const positions = el('ol', 'game-positions');
    steps.forEach((step, i) => {
      const ok = step === order.steps[i];
      positions.append(
        el('li', ok ? 'game-position' : 'game-position game-position--wrong',
          `Position ${i + 1}: "${step}". ${ok ? 'Right.' : 'Not quite here.'}`),
      );
    });
    feedback.append(positions);

    feedback.append(el('p', 'game-verdict', 'The correct order is:'));
    const correctList = el('ol', 'game-steps-correct');
    order.steps.forEach((step) => correctList.append(el('li', '', step)));
    feedback.append(correctList);

    renderQuote(feedback, ctx, order.quote, order.bite);

    const next = button('See result');
    next.addEventListener('click', () => finish(ctx, correct, total));
    feedback.append(next);

    root.append(feedback);
    feedback.focus();
  });
}

export function mountGame(container, { game, kind, jump, onDone }) {
  container.textContent = '';
  const root = el('section', 'game');
  container.append(root);

  const ctx = {
    root,
    game,
    kind,
    jump,
    onDone,
    id: `game-${++mountCount}`,
    finished: false,
  };

  if (kind === 'order') {
    renderOrder(ctx);
    return;
  }

  const items = kind === 'quiz'
    ? game.quiz.map((q) => ({
      prompt: q.question,
      options: q.options,
      correctIndex: q.answer,
      correctText: q.options[q.answer],
      quote: q.quote,
      bite: q.bite,
    }))
    : game.truefalse.map((s) => ({
      prompt: s.statement,
      options: ['True', 'False'],
      correctIndex: s.answer ? 0 : 1,
      correctText: s.answer ? 'True' : 'False',
      quote: s.quote,
      bite: s.bite,
    }));

  renderChoice(ctx, items, 0, []);
  root.querySelector('fieldset').focus();
}
