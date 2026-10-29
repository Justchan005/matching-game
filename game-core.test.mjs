import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_SCENARIOS, shuffleSteps, scoreOrder, moveItem, validateScenario } from './game-core.mjs';

test('shuffling preserves every step and never presents an already solved round', () => {
  const steps = ['Ask', 'Check', 'Confirm', 'Prepare', 'Welcome'];
  for (const sample of [0, 0.25, 0.5, 0.75, 0.999999, 1]) {
    const items = shuffleSteps(steps, () => sample);
    assert.deepEqual([...items].sort((a, b) => a.id - b.id).map((item) => item.text), steps);
    assert.equal(new Set(items.map((item) => item.id)).size, steps.length);
    assert.notEqual(scoreOrder(items).score, 100);
  }
  assert.deepEqual(steps, ['Ask', 'Check', 'Confirm', 'Prepare', 'Welcome']);
  assert.deepEqual(shuffleSteps([]), []);
  assert.deepEqual(shuffleSteps(['Only step']), [{ id: 0, text: 'Only step' }]);
});

test('scoring reports correct positions, including partial and empty rounds', () => {
  const items = [0, 1, 2, 3, 4].map((id) => ({ id }));
  assert.deepEqual(scoreOrder(items), { correct: 5, total: 5, score: 100 });
  assert.deepEqual(scoreOrder([items[1], items[0], items[2], items[3], items[4]]), { correct: 3, total: 5, score: 60 });
  assert.deepEqual(scoreOrder([items[1], items[2], items[3], items[4], items[0]]), { correct: 0, total: 5, score: 0 });
  assert.deepEqual(scoreOrder([]), { correct: 0, total: 0, score: 0 });
});

test('the nine-step diagnosis round scores partial progress with rounded percentages', () => {
  const items = SAMPLE_SCENARIOS[0].steps.map((text, id) => ({ id, text }));
  assert.deepEqual(scoreOrder(items), { correct: 9, total: 9, score: 100 });
  const swapped = [items[1], items[0], ...items.slice(2)];
  assert.deepEqual(scoreOrder(swapped), { correct: 7, total: 9, score: 78 });
  const shuffled = shuffleSteps(SAMPLE_SCENARIOS[0].steps);
  assert.equal(shuffled.length, 9);
  assert.notEqual(scoreOrder(shuffled).score, 100);
});

test('movement works in either direction without mutating the previous sequence', () => {
  const items = ['one', 'two', 'three', 'four'];
  assert.deepEqual(moveItem(items, 0, 3), ['two', 'three', 'four', 'one']);
  assert.deepEqual(moveItem(items, 3, 0), ['four', 'one', 'two', 'three']);
  assert.deepEqual(moveItem(items, 1, 2), ['one', 'three', 'two', 'four']);
  for (const [from, to] of [[-1, 2], [0, 4], [1, 1], [0.5, 2]]) {
    assert.deepEqual(moveItem(items, from, to), items);
  }
  assert.deepEqual(items, ['one', 'two', 'three', 'four']);
});

test('the diagnosis scenario satisfies the same requirements as custom scenarios', () => {
  assert.equal(SAMPLE_SCENARIOS.length, 1);
  assert.equal(SAMPLE_SCENARIOS[0].id, 'diagnosis');
  for (const scenario of SAMPLE_SCENARIOS) {
    assert.deepEqual(validateScenario(scenario), { valid: true, errors: [] });
    assert.equal(scenario.steps.length, 9);
  }
});

test('validation rejects missing fields, duplicates, blank steps, and length limits', () => {
  const valid = { title: 'Welcome guests', description: 'Open the check-in desk.', steps: ['Ask', 'Check', 'Welcome'] };
  assert.equal(validateScenario(valid).valid, true);
  assert.equal(validateScenario({ ...valid, steps: Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`) }).valid, true);
  for (const scenario of [
    null, {},
    { ...valid, title: ' ' },
    { ...valid, title: 'x'.repeat(81) },
    { ...valid, description: '' },
    { ...valid, description: 'x'.repeat(501) },
    { ...valid, steps: ['Ask', 'Check'] },
    { ...valid, steps: Array.from({ length: 13 }, (_, i) => String(i)) },
    { ...valid, steps: ['Ask', ' ask ', 'Welcome'] },
    { ...valid, steps: ['Ask', ' ', 'Welcome'] },
    { ...valid, steps: ['Ask', null, 'Welcome'] },
    { ...valid, steps: ['Ask', 'x'.repeat(161), 'Welcome'] },
  ]) {
    const result = validateScenario(scenario);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});
