import { advance, createRun, getResult } from '../assets/js/engine.js';

const BASE = 'http://127.0.0.1:8787';

function perfectInputs(seed, durationTicks, reaction = 6, typing = 3) {
  const run = createRun({ seed, durationTicks });
  const inputs = [];
  let due = null;
  while (run.status === 'running') {
    if (!run.prompt) due = null;
    else if (due === null) due = run.tick + reaction;
    let batch = [];
    if (run.prompt && due !== null && run.tick >= due) {
      const key = run.prompt.seq[run.prompt.index];
      batch = [key];
      inputs.push({ t: run.tick, k: key });
      due = run.prompt.index + 1 >= run.prompt.seq.length ? null : run.tick + typing;
    }
    advance(run, batch);
  }
  return inputs;
}

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

const people = [
  { login: '山月', name: '山月', reaction: 2, typing: 1 },
  { login: '行舟', name: '行舟', reaction: 4, typing: 2 },
  { login: '迟照', name: '迟照', reaction: 8, typing: 5 },
  { login: '阿眠', name: '阿眠', reaction: 18, typing: 10 },
  { login: '半途', name: '半途', reaction: 45, typing: 28 },
];

for (const person of people) {
  const session = await call('/api/dev/login', { method: 'POST', body: { login: person.login, name: person.name } });
  const challenge = await call('/api/challenges', { method: 'POST', token: session.token, body: {} });
  const inputs = perfectInputs(challenge.seed, challenge.durationTicks, person.reaction, person.typing);
  const result = await call('/api/runs', { method: 'POST', token: session.token, body: { challengeId: challenge.id, inputs } });
  console.log(person.name, result.run.score, 'rank', result.rank, 'successes', result.run.successes);
}
