export const SAMPLE_SCENARIOS = [
  {
    id: 'diagnosis',
    title: 'The road to a diagnosis',
    category: 'PATIENT JOURNEY',
    description: 'Can you put the steps in the correct order to receive a diagnosis?',
    steps: [
      'Schedule a medical appointment.',
      'Arrive at the clinic and complete registration or check-in.',
      'Wait in the waiting room for your appointment with the doctor.',
      'See the doctor, who identifies the need for further tests.',
      'Receive an X-ray referral from the doctor.',
      'Book a date and time for the X-ray.',
      'Attend the X-ray appointment.',
      'Have the X-ray taken.',
      'The doctor evaluates the X-ray results, confirms the diagnosis, and prescribes therapy.',
    ],
    explanation: 'In this scenario, you first register and see the doctor. The referral comes before booking the X-ray, and the doctor reviews the results after the X-ray is taken.',
  },
];

/** Each item's id records its position in the correct sequence. */
export function shuffleSteps(steps, random = Math.random) {
  const shuffled = steps.map((text, id) => ({ id, text }));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = random();
    const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON) : 0;
    const swapIndex = Math.floor(bounded * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  if (shuffled.length > 1 && shuffled.every((item, index) => item.id === index)) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }
  return shuffled;
}

export function scoreOrder(items) {
  const total = items.length;
  const correct = items.reduce((count, item, index) => count + Number(item.id === index), 0);
  return { correct, total, score: total === 0 ? 0 : Math.round((correct / total) * 100) };
}

export function moveItem(items, from, to) {
  const moved = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to < 0 || from >= moved.length || to >= moved.length || from === to) {
    return moved;
  }
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  return moved;
}

export function validateScenario(scenario = {}) {
  const { title, description, steps } = scenario ?? {};
  const errors = [];
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 80) {
    errors.push('Enter a scenario title between 1 and 80 characters.');
  }
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 500) {
    errors.push('Enter a scenario description between 1 and 500 characters.');
  }
  if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
    errors.push('Add between 3 and 12 steps in the correct order.');
  }
  if (Array.isArray(steps)) {
    if (steps.some((step) => typeof step !== 'string' || !step.trim() || step.trim().length > 160)) {
      errors.push('Each step must contain between 1 and 160 characters.');
    }
    const normalized = steps.filter((step) => typeof step === 'string').map((step) => step.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      errors.push('Give every step different wording.');
    }
  }
  return { valid: errors.length === 0, errors };
}
