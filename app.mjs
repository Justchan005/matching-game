import { SAMPLE_SCENARIOS, shuffleSteps, scoreOrder, moveItem, validateScenario } from './game-core.mjs';

const $ = (id) => document.getElementById(id);
const STORAGE = { scenarios: 'flow-state.scenarios.v1', scores: 'flow-state.scores.v1' };
const notice = (message) => { $('notice').textContent = message; $('notice').hidden = false; };

function readStored(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    notice('Browser storage is unavailable or could not be read. You can still play this session.');
    return [];
  }
}

function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { notice('Your changes are available this session, but this browser could not save them. Keep this page open to retain them.'); }
}

const customScenarios = readStored(STORAGE.scenarios).filter((scenario) =>
  typeof scenario?.id === 'string' && scenario.id.startsWith('custom-') && validateScenario(scenario).valid);
const scenarios = [...SAMPLE_SCENARIOS, ...customScenarios];
let scores = readStored(STORAGE.scores).filter((entry) => entry &&
  typeof entry.scenarioId === 'string' && typeof entry.name === 'string' && entry.name.length <= 30 &&
  Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 100 &&
  Number.isFinite(entry.seconds) && entry.seconds >= 0);
let scenario = scenarios[0];
let items = [];
let phase = 'ready';
let startedAt = 0;
let timerId;
let draggedId = null;
let roundName = '';

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function elapsed() { return Math.max(0, Math.floor((performance.now() - startedAt) / 1000)); }
function updateTimer() { $('timer').textContent = formatTime(elapsed()); }

function renderOptions() {
  $('scenario-select').replaceChildren(...scenarios.map((entry) => {
    const option = node('option', '', entry.title);
    option.value = entry.id;
    return option;
  }));
  $('scenario-select').value = scenario.id;
}

function renderScores() {
  const selected = scores.filter((entry) => entry.scenarioId === scenario.id)
    .sort((a, b) => b.score - a.score || a.seconds - b.seconds).slice(0, 8);
  $('empty-scores').hidden = selected.length > 0;
  $('leaderboard-list').replaceChildren(...selected.map((entry, index) => {
    const row = node('li', 'leaderboard-row');
    row.append(node('span', 'rank', `${index + 1}`), node('span', 'entry-name', entry.name),
      node('span', 'entry-score', `${entry.score} / 100 · ${formatTime(entry.seconds)}`));
    return row;
  }));
}

function reorder(from, to, focusDirection) {
  if (phase !== 'playing' || from === to || to < 0 || to >= items.length) return;
  const moved = items[from];
  items = moveItem(items, from, to);
  renderCards();
  if (focusDirection) {
    const card = $('flow-list').querySelector(`[data-step-id="${moved.id}"]`);
    const preferred = card.querySelector(`[data-direction="${focusDirection}"]`);
    (preferred.disabled ? card.querySelector('button:not(:disabled)') : preferred)?.focus({ preventScroll: true });
  }
  $('move-announcement').textContent = `${moved.text} Moved to position ${to + 1} of ${items.length}.`;
}

function renderCards() {
  $('flow-list').replaceChildren(...items.map((item, index) => {
    const correct = item.id === index;
    const card = node('li', `flow-card${phase === 'complete' ? (correct ? ' is-correct' : ' is-incorrect') : ''}`);
    card.dataset.stepId = item.id;
    card.draggable = phase === 'playing';
    const order = node('span', 'card-order', `${index + 1}`.padStart(2, '0'));
    order.setAttribute('aria-hidden', 'true');
    const text = node('span', 'card-text', item.text);
    const actions = node('div', 'card-actions');
    for (const [direction, symbol, destination] of [['up', '↑', index - 1], ['down', '↓', index + 1]]) {
      const button = node('button', 'move-button', symbol);
      button.type = 'button';
      button.dataset.direction = direction;
      button.setAttribute('aria-label', `Move step ${index + 1} ${direction}: ${item.text}`);
      button.disabled = phase !== 'playing' || destination < 0 || destination >= items.length;
      button.addEventListener('click', () => reorder(index, destination, direction));
      actions.append(button);
    }
    const handle = node('span', 'drag-handle', '⠿');
    handle.setAttribute('aria-hidden', 'true');
    card.append(order, text, actions, handle);
    if (phase === 'complete') card.append(node('span', 'sr-only', correct ? 'Correct position.' : 'Incorrect position.'));
    card.addEventListener('dragstart', (event) => {
      if (phase !== 'playing' || event.target.closest('button')) { event.preventDefault(); return; }
      draggedId = item.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(item.id));
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragover', (event) => {
      if (phase !== 'playing' || draggedId === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', (event) => {
      if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      if (phase !== 'playing' || draggedId === null) return;
      const from = items.findIndex((entry) => entry.id === draggedId);
      draggedId = null;
      if (from >= 0) reorder(from, index);
    });
    card.addEventListener('dragend', () => {
      draggedId = null;
      document.querySelectorAll('.is-dragging, .drag-over').forEach((entry) => entry.classList.remove('is-dragging', 'drag-over'));
    });
    return card;
  }));
}

function prepareRound() {
  clearInterval(timerId);
  phase = 'ready';
  draggedId = null;
  items = shuffleSteps(scenario.steps);
  $('timer').textContent = '00:00';
  $('scenario-title').textContent = scenario.title;
  $('scenario-description').textContent = scenario.description;
  $('scenario-category').textContent = scenario.category || 'YOUR SCENARIO';
  $('scenario-number').textContent = `${String(scenarios.indexOf(scenario) + 1).padStart(2, '0')} / ${String(scenarios.length).padStart(2, '0')}`;
  $('step-count').textContent = `${scenario.steps.length} steps`;
  $('round-status').textContent = 'Ready when you are. Start a round to begin.';
  $('round-status').parentElement.classList.remove('is-active');
  $('result-panel').hidden = true;
  $('start-round').hidden = false;
  $('start-round').textContent = 'Start round →';
  $('submit-flow').disabled = true;
  $('submit-flow').hidden = false;
  $('reset-round').hidden = true;
  for (const id of ['scenario-select', 'player-name', 'customize-button']) $(id).disabled = false;
  renderCards();
  renderScores();
}

function startRound(event) {
  event.preventDefault();
  if (phase === 'playing') return;
  prepareRound();
  phase = 'playing';
  roundName = $('player-name').value.trim() || 'Guest player';
  startedAt = performance.now();
  timerId = setInterval(updateTimer, 250);
  $('round-status').textContent = `${roundName}, find the flow. Your round is in progress.`;
  $('round-status').parentElement.classList.add('is-active');
  $('start-round').hidden = true;
  $('submit-flow').disabled = false;
  $('reset-round').hidden = false;
  for (const id of ['scenario-select', 'player-name', 'customize-button']) $(id).disabled = true;
  renderCards();
  $('flow-list').querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  $('flow-list').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

function finishRound() {
  if (phase !== 'playing') return;
  const seconds = elapsed();
  clearInterval(timerId);
  $('timer').textContent = formatTime(seconds);
  phase = 'complete';
  const result = scoreOrder(items);
  $('round-status').textContent = 'Round complete. Your results are below.';
  $('round-status').parentElement.classList.remove('is-active');
  $('score-value').textContent = result.score;
  $('result-title').textContent = result.correct === result.total ? 'You found your flow!' : 'Every step is a learning moment.';
  $('result-description').textContent = `${roundName}, you placed ${result.correct} of ${result.total} steps correctly in ${formatTime(seconds)}. ${result.correct === result.total ? 'A perfect sequence. Nicely done!' : 'Compare your sequence with the intended flow below, then try again.'}`;
  $('answer-list').replaceChildren(...scenario.steps.map((step) => node('li', '', step)));
  $('explanation').textContent = scenario.explanation || 'This is the intended sequence entered by your event host.';
  $('result-panel').hidden = false;
  $('submit-flow').hidden = true;
  $('submit-flow').disabled = true;
  $('reset-round').hidden = true;
  $('start-round').hidden = false;
  $('start-round').textContent = 'Play again →';
  for (const id of ['scenario-select', 'player-name', 'customize-button']) $(id).disabled = false;
  renderCards();
  scores.push({ scenarioId: scenario.id, name: roundName, score: result.score, seconds });
  scores = scenarios.flatMap((entry) => scores.filter((score) => score.scenarioId === entry.id)
    .sort((a, b) => b.score - a.score || a.seconds - b.seconds).slice(0, 8));
  saveStored(STORAGE.scores, scores);
  renderScores();
  $('result-title').focus({ preventScroll: true });
  $('result-panel').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

$('round-form').addEventListener('submit', startRound);
$('submit-flow').addEventListener('click', finishRound);
$('reset-round').addEventListener('click', () => { prepareRound(); $('start-round').focus(); });
$('scenario-select').addEventListener('change', () => {
  scenario = scenarios.find((entry) => entry.id === $('scenario-select').value);
  prepareRound();
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('customize-button').addEventListener('click', () => { $('custom-error').hidden = true; $('custom-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('custom-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const custom = {
    id: `custom-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
    title: $('custom-name').value.trim(),
    description: $('custom-description').value.trim(),
    category: 'YOUR EVENT',
    steps: $('custom-steps').value.trim().split(/\r?\n/).map((step) => step.trim()),
  };
  const validation = validateScenario(custom);
  if (!validation.valid) {
    $('custom-error').textContent = validation.errors.join(' ');
    $('custom-error').hidden = false;
    return;
  }
  customScenarios.push(custom);
  scenarios.push(custom);
  saveStored(STORAGE.scenarios, customScenarios);
  scenario = custom;
  renderOptions();
  prepareRound();
  $('custom-dialog').close();
  $('custom-form').reset();
  $('start-round').focus();
});

renderOptions();
prepareRound();
