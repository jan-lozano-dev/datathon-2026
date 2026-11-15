'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { activate } = require('../src/backend.cjs');
const scheduler = require('../src/scheduler.cjs');
const { defaults } = require('../src/store.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const node = (id, source = 'source') => ({ id, name: `Fact ${id}`, statement: `Statement ${id}`, provenance: [{ chatId: source }] });
const graph = (...ids) => ({ propositions: ids.map(id => node(id)), chains: [], sessions: { source: 'Source lesson' }, fileSources: {} });
const cards = (id, ...questions) => ({ propositionId: id, cards: questions.map(question => ({ question, answer: `Answer: ${question}` })) });
const result = (...rows) => ({ propositions: rows });

function harness(t, initialGraph = graph('p1')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcards-test-'));
  const h = { graph: initialGraph, directory };
  let handlers, controller, cleanups = [];
  h.dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); controller?.abort(); };
  h.activate = () => {
    h.dispose(); handlers = new Map(); controller = new AbortController();
    // The practice build's host: no learning graph, workers or inference.
    activate({ dataDirectory: directory, signal: controller.signal,
      events: { emit() {} }, handle: (name, handler) => handlers.set(name, handler),
      cleanup: fn => { assert.equal(typeof fn, 'function'); cleanups.push(fn); },
    });
  };
  h.call = async (name, input = {}) => { assert.ok(handlers.has(name), name); return handlers.get(name)(input); };
  h.state = () => handlers.get('get-state')({});
  h.disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'flashcards.json'), 'utf8'));
  // Seeds cards as earlier builds' graph generation stored them (deck named
  // after the source, origin 'graph'), then reloads: generation itself is gone.
  h.generate = async (...rows) => {
    h.dispose();
    const file = path.join(directory, 'flashcards.json');
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { version: 1, revision: 0, settings: defaults(), decks: [], propositions: {}, reviews: [], batches: [] };
    for (const row of rows) {
      const source = h.graph.propositions.find(n => n.id === row.propositionId) ?? node(row.propositionId);
      let p = s.propositions[row.propositionId];
      if (!p) {
        let destination = s.decks.find(d => d.sourceId === 'source');
        if (!destination) { destination = { id: randomUUID(), name: 'Source lesson', sourceId: 'source', newLimit: 20, propositionIds: [] }; s.decks.push(destination); }
        p = { id: row.propositionId, origin: 'graph', name: source.name, statement: source.statement, snapshot: source, cues: [], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
        s.propositions[p.id] = p; destination.propositionIds.push(p.id);
      }
      const seen = new Set(p.cues.map(c => c.question.trim()));
      for (const card of row.cards) if (!seen.has(card.question.trim())) { seen.add(card.question.trim()); p.cues.push({ id: randomUUID(), question: card.question, answer: card.answer, latestRating: null }); p.version++; }
    }
    s.revision++;
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s));
    h.activate();
    return h.state();
  };
  h.grade = async (scope, rating = 4, requestId = randomUUID()) => {
    const { ticket } = await h.call('next-review', scope);
    assert.ok(ticket);
    await h.call('reveal-review', { ticketId: ticket.id });
    await h.call('rate-review', { ticketId: ticket.id, rating, requestId });
    return ticket;
  };
  h.activate();
  t.after(() => { h.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return h;
}

test('content deletion is global and permanent, preserves surviving schedules and history, and cleans only affected empty decks', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Remove one', 'Remove two'), cards('p2', 'Keep'));
  await h.call('create-deck', { name: 'Shared' }); await h.call('create-deck', { name: 'Unrelated empty deck' });
  const shared = h.state().decks.find(d => d.name === 'Shared'), unrelated = h.state().decks.find(d => d.name === 'Unrelated empty deck');
  await h.call('set-memberships', { propositionId: 'p1', deckIds: [h.state().decks[0].id, shared.id] });
  await h.grade({ propositionIds: ['p1'] }, 1);
  const p = h.state().propositions.find(p => p.id === 'p1'), history = h.disk().reviews;
  const removed = p.cues.find(c => c.id === p.learningCueId);
  await h.call('delete-content', { revision: h.state().revision, cueIds: [removed.id, removed.id], deleteEmptyDecks: true, requestId: 'remove-one' });
  const surviving = h.state().propositions.find(p => p.id === 'p1');
  assert.deepEqual(surviving.schedule, p.schedule); assert.equal(surviving.learningCueId, null);
  assert.deepEqual(surviving.memberships, p.memberships); assert.equal(surviving.cues.length, 1); assert.equal(surviving.version, p.version + 1);
  assert.equal(JSON.stringify(h.disk()).includes(removed.question), false, 'no deleted question/answer tombstone is retained');
  await h.call('delete-content', { revision: h.state().revision, propositionIds: ['p1'], deleteEmptyDecks: true, requestId: 'remove-target' });
  assert.equal(h.state().propositions.some(p => p.id === 'p1'), false);
  assert.equal(h.state().decks.some(d => d.id === shared.id), false);
  assert.equal(h.state().decks.some(d => d.id === unrelated.id), true, 'unrelated empty decks are untouched');
  assert.deepEqual(h.state().decks[0].propositionIds, ['p2']); assert.deepEqual(h.disk().reviews, history);
  assert.equal(h.state().statistics.activity.at(-1).count, 1); assert.equal(h.state().statistics.states.learning, 0);
  h.activate(); assert.equal(JSON.stringify(h.disk()).includes('Remove two'), false);
});

test('content deletion can retain emptied containers; direct deck deletion removes its shared contents without a replacement', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Only cue'));
  await h.call('create-deck', { name: 'Shared' });
  const deckIds = h.state().decks.map(d => d.id);
  await h.call('set-memberships', { propositionId: 'p1', deckIds });
  await h.call('delete-content', { revision: h.state().revision, deckIds: [deckIds[0]], deleteEmptyDecks: false, requestId: 'retain-decks' });
  assert.equal(h.state().propositions.length, 0); assert.deepEqual(h.state().decks.map(d => d.id), deckIds);
  assert.ok(h.state().decks.every(d => d.propositionIds.length === 0));
  await h.call('delete-deck', { id: deckIds[0] });
  assert.deepEqual(h.state().decks.map(d => d.id), [deckIds[1]], 'selected empty deck is deleted, unrelated empty decks survive');
});

test('content deletion validates the whole selection and stale snapshots atomically and safely retries a lost response', async t => {
  const h = harness(t); await h.generate(cards('p1', 'One', 'Two'));
  const before = h.disk(), cueId = h.state().propositions[0].cues[0].id;
  const input = { revision: h.state().revision, cueIds: [cueId], deleteEmptyDecks: true, requestId: 'delete-once' };
  for (const patch of [{ cueIds: [cueId, 'missing'] }, { propositionIds: ['missing'] }, { deckIds: ['missing'] }, { cueIds: 'wrong' }, { cueIds: null }, { cueIds: [] }, { deleteEmptyDecks: 'yes' }, { requestId: '' }, { revision: input.revision - 1 }]) {
    await assert.rejects(h.call('delete-content', { ...input, ...patch })); assert.deepEqual(h.disk(), before);
  }
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Deletion save unavailable'); });
  try { await assert.rejects(h.call('delete-content', input), /Deletion save unavailable/); }
  finally { rename.mock.restore(); }
  assert.deepEqual(h.disk(), before); assert.equal(h.state().propositions[0].cues.length, 2);
  await h.call('delete-content', input); const accepted = h.disk();
  h.activate(); await h.call('delete-content', input); assert.deepEqual(h.disk(), accepted, 'same request cannot delete more content or fail as stale');
  await assert.rejects(h.call('delete-content', { ...input, deleteEmptyDecks: false }), /different work/);
});

test('legacy tombstones are purged on activation without losing text-free manual creation receipts or past review statistics', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Keep active', 'LEGACY_SECRET_QUESTION'));
  await h.call('create-deck', { name: 'Manual deck' });
  const request = { deckId: h.state().decks[1].id, name: 'LEGACY_SECRET_TARGET', question: 'LEGACY_MANUAL_QUESTION', answer: 'LEGACY_MANUAL_ANSWER', requestId: 'legacy-create' };
  const created = await h.call('create-card', request); await h.grade({ propositionIds: [created.propositionId] });
  const old = h.disk(), history = structuredClone(old.reviews);
  old.propositions.p1.cues[1].deleted = true;
  const manual = old.propositions[created.propositionId].cues[0], receipt = old.creationReceipts[0];
  manual.creation = { requestId: receipt.requestId, hash: receipt.hash }; manual.deleted = true; delete old.creationReceipts;
  old.reviews[0].question = manual.question; old.reviews[0].answer = manual.answer;
  h.dispose(); fs.writeFileSync(path.join(h.directory, 'flashcards.json'), JSON.stringify(old)); h.activate();
  const migrated = h.disk(), text = JSON.stringify(migrated);
  for (const secret of ['LEGACY_SECRET_QUESTION', 'LEGACY_SECRET_TARGET', 'LEGACY_MANUAL_QUESTION', 'LEGACY_MANUAL_ANSWER']) assert.equal(text.includes(secret), false, secret);
  assert.equal(h.state().propositions.length, 1); assert.deepEqual(h.disk().reviews, history);
  assert.equal(h.state().decks.some(d => d.id === request.deckId), true, 'migration does not remove containers');
  assert.equal((await h.call('create-card', request)).propositionId, created.propositionId);
  assert.deepEqual(h.disk(), migrated, 'retry never restores a physically deleted manual card');
  h.activate(); assert.deepEqual(h.disk(), migrated, 'migration runs only once');
});

test('manual creation atomically makes a local target and first cue in the chosen deck without graph writes or model calls', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Handwritten' });
  const deckId = h.state().decks[0].id;
  const input = { deckId, name: '  My target  ', question: 'Question **Markdown**?', answer: '$x = 1$', requestId: 'manual-create' };
  const created = await h.call('create-card', input), p = created.state.propositions[0];
  assert.equal(p.id, created.propositionId); assert.equal(p.name, 'My target'); assert.equal(p.origin, 'manual'); assert.equal(p.archived, false);
  assert.deepEqual(p.memberships, [deckId]); assert.deepEqual(created.state.decks[0].propositionIds, [p.id]);
  assert.equal(p.cues.length, 1); assert.equal(p.cues[0].id, created.cueId); assert.equal(p.cues[0].question, input.question); assert.equal(p.cues[0].answer, input.answer);
  assert.equal(p.schedule.state, 0); assert.equal(p.firstReviewedAt, null); assert.equal(p.learningCueId, null);
  assert.deepEqual(created.state.statistics.states, { new: 1, learning: 0, review: 0, relearning: 0 });
  assert.deepEqual(fs.readdirSync(h.directory), ['flashcards.json'], 'manual content needs neither file sources nor task records');
  h.activate(); assert.equal(h.state().propositions[0].archived, false);
  await h.grade({ cueIds: [created.cueId] }, 1);
  assert.equal(h.state().decks[0].newToday, 1); assert.equal(h.state().propositions[0].schedule.state, 1);
  const another = await h.call('create-card', { ...input, requestId: 'another-intentional-create' });
  assert.notEqual(another.propositionId, p.id, 'a deliberate new save creates a new target instead of matching labels');
  await h.call('reorder', { kind: 'proposition', deckId, id: another.propositionId, direction: -1 });
  assert.deepEqual(h.state().decks[0].propositionIds, [another.propositionId, p.id]);
});

test('manual creation receipts survive restart, editing and deletion; duplicate deliveries never add another target or cue', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Manual' });
  const create = { deckId: h.state().decks[0].id, name: 'Target', question: 'Question', answer: 'Answer', requestId: 'create-once' };
  const first = await h.call('create-card', create), before = h.disk();
  const repeated = await h.call('create-card', create); assert.equal(repeated.propositionId, first.propositionId); assert.equal(repeated.cueId, first.cueId); assert.deepEqual(h.disk(), before);
  await assert.rejects(h.call('create-card', { ...create, answer: 'Different' }), /different work/);
  const append = { propositionId: first.propositionId, question: 'Second', answer: 'Answer', requestId: 'append-once' };
  const second = await h.call('create-cue', append);
  await h.call('save-cue', { propositionId: first.propositionId, cueId: second.cueId, question: 'Edited', answer: 'Edited answer', version: h.state().propositions[0].version });
  await h.call('delete-cue', { propositionId: first.propositionId, cueId: second.cueId, version: h.state().propositions[0].version });
  h.activate(); const saved = h.disk();
  const retry = await h.call('create-cue', append); assert.equal(retry.cueId, second.cueId); assert.deepEqual(h.disk(), saved);
  const retryCreate = await h.call('create-card', create); assert.equal(retryCreate.propositionId, first.propositionId); assert.deepEqual(h.disk(), saved);
  await assert.rejects(h.call('create-cue', { ...append, question: 'Changed request' }), /different work/);
  assert.equal(h.state().propositions.length, 1); assert.equal(h.state().propositions[0].cues.length, 1);
});

test('manual atomic save failure leaves no empty target and a retry creates exactly one complete card', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Manual' });
  const input = { deckId: h.state().decks[0].id, name: 'Name', question: 'Question', answer: 'Answer', requestId: 'retry-save' }, before = h.disk();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic manual save failure'); });
  await assert.rejects(h.call('create-card', input), /Synthetic manual save failure/); assert.deepEqual(h.disk(), before); assert.equal(h.state().propositions.length, 0);
  rename.mock.restore(); await h.call('create-card', input); await h.call('create-card', input);
  assert.equal(h.state().propositions.length, 1); assert.equal(h.state().propositions[0].cues.length, 1);
});

const fileFact = (name, statement, ...questions) => ({ name, statement, cards: questions.map(question => ({ question, answer: `Answer: ${question}` })) });
const fileResult = (...facts) => ({ facts });
const fileInput = () => ({ name: 'lesson.notes.md', markdown: 'UNIQUE SOURCE MARKDOWN\n\nThe original converted notes are retained separately.' });
const chunkedFile = () => ({ name: 'notes.md', markdown: Array.from({ length: 4 }, (_, i) => `Section ${i}\n${'Text '.repeat(100)}\n\n`).join('') });

test('reordering skips deleted cues', async t => {
  const h = harness(t, graph('p1', 'p2', 'p3'));
  await h.generate(cards('p1', 'First', 'Deleted', 'Last'), cards('p2', 'Middle'), cards('p3', 'Third'));
  const first = h.state().propositions.find(p => p.id === 'p1');
  await h.call('delete-cue', { propositionId: 'p1', cueId: first.cues[1].id, version: first.version });
  await h.call('reorder', { kind: 'cue', propositionId: 'p1', id: first.cues[2].id, direction: -1 });
  assert.deepEqual(h.state().propositions.find(p => p.id === 'p1').cues.filter(c => !c.deleted).map(c => c.question), ['Last', 'First']);
  const deckId = h.state().decks[0].id;
  await h.call('reorder', { kind: 'proposition', deckId, id: 'p3', direction: -1 });
  assert.deepEqual(h.state().decks[0].propositionIds, ['p1', 'p3', 'p2']);
});

test('review hides answer until reveal, requires reveal, and grading is idempotent', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Question'));
  const { ticket } = await h.call('next-review');
  assert.ok(ticket.question);
  assert.equal(Object.hasOwn(ticket, 'answer'), false);
  assert.equal(JSON.stringify(ticket).includes('Answer:'), false);
  const requestId = randomUUID();
  await assert.rejects(h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId }), /Reveal/);
  const revealed = await h.call('reveal-review', { ticketId: ticket.id });
  assert.equal(revealed.answer, 'Answer: Question');
  assert.deepEqual(Object.keys(revealed.intervals), ['1', '2', '3', '4']);
  await h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId });
  const after = h.state();
  await h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId });
  assert.deepEqual(h.state(), after);
  assert.equal(h.disk().reviews.length, 1);
});

test('review tickets invalidate when card content or scheduling settings change', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Original question'));
  const { ticket } = await h.call('next-review');
  const p = h.state().propositions[0];
  await h.call('save-cue', { propositionId: p.id, cueId: p.cues[0].id, question: 'Changed question', answer: 'Changed answer', version: p.version });
  await assert.rejects(h.call('reveal-review', { ticketId: ticket.id }), /changed elsewhere/);
  const next = (await h.call('next-review')).ticket;
  await h.call('reveal-review', { ticketId: next.id });
  await h.call('save-settings', { retention: .95 });
  await assert.rejects(h.call('rate-review', { ticketId: next.id, rating: 4, requestId: randomUUID() }), /changed elsewhere/);
  assert.equal(h.disk().reviews.length, 0);
});

test('shared schedules charge every containing deck but admission uses only the studied deck; due is uncapped', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'One cue'), cards('p2', 'Another cue'));
  const source = h.state().decks[0];
  await h.call('save-deck', { id: source.id, name: source.name, newLimit: 1 });
  await h.call('create-deck', { name: 'Shared' });
  const shared = h.state().decks.find(d => d.name === 'Shared');
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 0 });
  await h.call('set-memberships', { propositionId: 'p1', deckIds: [source.id, shared.id] });
  const first = await h.grade({ deckIds: [source.id] }, 1);
  assert.equal(first.propositionId, 'p1');
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  assert.equal((await h.call('next-review', { deckIds: [source.id] })).ticket, null);
  now += 60000;
  const repeated = await h.grade({ deckIds: [shared.id] }, 4);
  assert.equal(repeated.propositionId, 'p1');
  assert.equal(repeated.cueId, first.cueId);
  assert.equal(h.state().propositions.find(p => p.id === 'p1').schedule.reps, 2);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  await h.call('set-memberships', { propositionId: 'p2', deckIds: [source.id, shared.id] });
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 2 });
  assert.equal((await h.grade({ deckIds: [shared.id] })).propositionId, 'p2');
  assert.deepEqual(h.state().decks.map(d => d.newToday), [2, 2]);
  assert.deepEqual(h.disk().reviews.filter(r => r.introduced).map(r => r.deckIds), [[source.id, shared.id], [source.id, shared.id]]);
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 0 });
  now += 20 * 86400000;
  assert.ok((await h.call('next-review', { deckIds: [shared.id] })).ticket);
});

test('cue-filtered new review intersects deck/proposition scope and chooses only selected active cues', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Unselected', 'Selected one', 'Selected two'), cards('p2', 'Other proposition'));
  const [p1, p2] = h.state().propositions;
  const random = t.mock.method(Math, 'random', () => 0);
  const scope = { deckIds: [h.state().decks[0].id], propositionIds: ['p1'], cueIds: [p1.cues[1].id, p1.cues[2].id, p2.cues[0].id] };
  assert.equal((await h.call('next-review', scope)).ticket.cueId, p1.cues[1].id);
  random.mock.mockImplementation(() => .999);
  const { ticket } = await h.call('next-review', scope);
  assert.equal(ticket.cueId, p1.cues[2].id);
  assert.deepEqual(await h.call('next-review', { ...scope, cueIds: [p2.cues[0].id] }), { ticket: null, remaining: 0 });
  await h.call('create-deck', { name: 'Empty' });
  const empty = h.state().decks.find(d => d.name === 'Empty');
  assert.equal((await h.call('next-review', { ...scope, deckIds: [empty.id] })).ticket, null);
  // Tickets retain the original selection, rather than the caller's mutable arrays.
  scope.cueIds.splice(0, scope.cueIds.length, p1.cues[0].id);
  scope.propositionIds.length = 0; scope.deckIds.length = 0;
  assert.equal((await h.call('reveal-review', { ticketId: ticket.id })).answer, 'Answer: Selected two');
  await h.call('rate-review', { ticketId: ticket.id, rating: 4, requestId: 'filtered-new' });
  assert.equal(h.disk().reviews[0].cueId, p1.cues[2].id);
  assert.equal(h.disk().reviews[0].introduced, true);
});

test('normal due review retains weighted choice within the selected cue pool and never forces an early review', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t);
  await h.generate(cards('p1', 'Reviewed easy', 'Excluded untried', 'Selected untried'));
  const p = h.state().propositions[0], [easy, excluded, untried] = p.cues;
  await h.grade({ cueIds: [easy.id] }, 4);
  assert.equal((await h.call('next-review', { cueIds: [untried.id] })).ticket, null);
  now += 30 * 86400000;
  const before = h.state().propositions[0].schedule;
  const random = t.mock.method(Math, 'random', () => .2);
  const scope = { cueIds: [easy.id, untried.id] };
  // Easy has weight 1, untried weight 3: the boundary is 1/4, not 1/7.
  assert.equal((await h.call('next-review', scope)).ticket.cueId, easy.id);
  random.mock.mockImplementation(() => .3);
  assert.equal((await h.call('next-review', scope)).ticket.cueId, untried.id);
  assert.deepEqual(h.state().propositions[0].schedule, before);
  const ticket = await h.grade(scope, 4);
  assert.equal(ticket.cueId, untried.id);
  assert.equal(h.state().propositions[0].cues.find(c => c.id === excluded.id).latestRating, null);
  assert.equal(h.state().propositions[0].schedule.reps, 2);
  assert.deepEqual(h.disk().reviews.map(r => [r.cueId, r.introduced]), [[easy.id, true], [untried.id, false]]);
});

test('filtered cues share one proposition schedule, history and introduction across decks', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t);
  await h.generate(cards('p1', 'First cue', 'Second cue'));
  await h.call('create-deck', { name: 'Shared' });
  const [source, shared] = h.state().decks, p = h.state().propositions[0];
  await h.call('set-memberships', { propositionId: p.id, deckIds: [source.id, shared.id] });
  await h.grade({ deckIds: [source.id], cueIds: [p.cues[0].id] }, 4);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  assert.equal((await h.call('next-review', { deckIds: [shared.id], cueIds: [p.cues[1].id] })).ticket, null);
  now += 30 * 86400000;
  await h.grade({ deckIds: [shared.id], cueIds: [p.cues[1].id] }, 4);
  assert.equal(h.state().propositions.length, 1);
  assert.equal(h.state().propositions[0].schedule.reps, 2);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [0, 0]);
  const reviews = h.disk().reviews;
  assert.deepEqual(reviews.map(r => r.introduced), [true, false]);
  assert.deepEqual(reviews[0].deckIds, [source.id, shared.id]);
  assert.deepEqual(reviews[1].before, reviews[0].after);
});

test('partial deck renames preserve the latest limit and limit-only patches preserve the latest name', async t => {
  const h = harness(t);
  await h.call('create-deck', { name: 'Original' });
  const original = h.state().decks[0];
  await h.call('save-deck', { id: original.id, name: 'Full update', newLimit: 7 });
  await h.call('save-deck', { id: original.id, newLimit: 37 });
  await h.call('save-deck', { id: original.id, name: '  Inline rename  ' });
  let d = h.state().decks[0];
  assert.equal(d.name, 'Inline rename');
  assert.equal(d.newLimit, 37);
  await h.call('save-deck', { id: original.id, newLimit: 0 });
  d = h.state().decks[0];
  assert.equal(d.name, 'Inline rename');
  assert.equal(d.newLimit, 0);
  const before = h.disk();
  for (const patch of [{ name: '' }, { newLimit: -1 }, { newLimit: '2' }, { name: 'Do not save', newLimit: null }]) {
    await assert.rejects(h.call('save-deck', { id: original.id, ...patch }));
    assert.deepEqual(h.disk(), before);
  }
  h.activate();
  assert.deepEqual(h.state().decks[0], d);
});

test('remaining includes current new propositions up to the daily cap, without writes or extra cue choices', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('p1', 'p2', 'p3'));
  await h.generate(cards('p1', 'First', 'Second cue'), cards('p2', 'Second proposition'), cards('p3', 'Third proposition'));
  const source = h.state().decks[0];
  let samples = 0;
  t.mock.method(Math, 'random', () => { samples++; return 0; });
  let before = h.disk();
  assert.equal((await h.call('next-review')).remaining, 3);
  assert.equal(samples, 1, 'counting makes no additional cue choices');
  assert.deepEqual(h.disk(), before);
  await h.call('save-deck', { id: source.id, newLimit: 2 });
  before = h.disk();
  const { ticket, remaining } = await h.call('next-review');
  assert.equal(remaining, 2);
  assert.equal(ticket.propositionId, 'p1');
  assert.equal((await h.call('next-review')).remaining, 2, 'repeated reads do not consume admissions');
  assert.equal(samples, 3);
  assert.deepEqual(h.disk(), before);
  await h.call('reveal-review', { ticketId: ticket.id });
  await h.call('rate-review', { ticketId: ticket.id, rating: 4, requestId: 'count-first' });
  assert.equal((await h.call('next-review')).remaining, 1);
  assert.equal((await h.grade({})).propositionId, 'p2');
  assert.deepEqual(await h.call('next-review'), { ticket: null, remaining: 0 });
  assert.equal(h.state().decks[0].newToday, 2);
});

test('remaining simulates deterministic shared-deck admission, charging every membership but gating only the admitting deck', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('shared', 'onlyA', 'onlyB'));
  await h.generate(cards('shared', 'Shared cue', 'Another shared cue'), cards('onlyA', 'A cue'), cards('onlyB', 'B cue'));
  const a = h.state().decks[0];
  await h.call('create-deck', { name: 'B' });
  const b = h.state().decks.find(d => d.name === 'B');
  await h.call('set-memberships', { propositionId: 'shared', deckIds: [a.id, b.id] });
  await h.call('set-memberships', { propositionId: 'onlyB', deckIds: [b.id] });
  await h.call('save-deck', { id: a.id, newLimit: 1 });
  await h.call('save-deck', { id: b.id, newLimit: 1 });
  let before = h.disk();
  assert.equal((await h.call('next-review')).remaining, 1, 'first shared introduction fills both allowances');
  assert.equal((await h.call('next-review', { deckIds: [b.id] })).remaining, 1);
  assert.deepEqual(h.disk(), before);
  await h.call('save-deck', { id: a.id, newLimit: 2 });
  assert.equal((await h.call('next-review')).remaining, 2, 'shared proposition is not counted twice');
  await h.call('save-deck', { id: b.id, newLimit: 0 });
  assert.equal((await h.call('next-review')).remaining, 2, 'zero allowance in another containing deck does not block A');
  assert.deepEqual(await h.call('next-review', { deckIds: [b.id] }), { ticket: null, remaining: 0 });
  await h.call('save-deck', { id: a.id, newLimit: 0 });
  await h.call('save-deck', { id: b.id, newLimit: 2 });
  before = h.disk();
  const first = await h.call('next-review');
  assert.equal(first.ticket.propositionId, 'shared');
  assert.equal(first.remaining, 2);
  assert.deepEqual(h.disk(), before);
  assert.equal((await h.grade({})).propositionId, 'shared');
  assert.equal((await h.call('next-review')).remaining, 1);
  assert.equal((await h.grade({})).propositionId, 'onlyB');
  assert.deepEqual(await h.call('next-review'), { ticket: null, remaining: 0 });
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 2]);
});

test('settings validate atomically; retired generation and model settings are refused and dropped', async t => {
  const h = harness(t);
  const before = h.state();
  for (const patch of [{ retention: .69 }, { retention: 1 }, { learningSteps: [] }, { relearningSteps: [10, 5] },
    { learningSteps: [1440] }, { dayStart: 24 }, { chunkBudget: 10 }, { modelOverride: null }, { thinkingOverride: 'off' }, { unknown: true }]) {
    await assert.rejects(h.call('save-settings', patch));
    assert.deepEqual(h.state(), before);
  }
  for (const key of ['chunkBudget', 'modelOverride', 'thinkingOverride']) assert.equal(Object.hasOwn(h.state().settings, key), false);
  const saved = await h.call('save-settings', { dayStart: 6 });
  assert.equal(saved.settings.dayStart, 6);
  assert.deepEqual(h.state().propositions, []);
});

test('no generation operations remain and activation needs no graph, workers or inference', async t => {
  const h = harness(t);
  for (const name of ['preflight', 'preflight-file', 'preflight-file-retry', 'open-file-deck', 'start-generation', 'cancel-generation', 'resume-results', 'get-catalog']) {
    await assert.rejects(h.call(name), new RegExp(name));
  }
  assert.equal(h.state().batch, null);
});

test('cards stored by earlier graph and file generation stay live and reviewable without the graph', async t => {
  const h = harness(t, graph('p1'));
  await h.generate(cards('p1', 'Legacy graph cue'));
  const file = path.join(h.directory, 'flashcards.json'), s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.settings = { ...s.settings, chunkBudget: 4000, modelOverride: { provider: 'old', id: 'model' } };
  s.propositions['file:1'] = { id: 'file:1', origin: 'file', sourceId: 'src', name: 'From a file', statement: 'S', cues: [{ id: 'fc', question: 'Legacy file cue', answer: 'A', latestRating: null }], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
  s.decks[0].propositionIds.push('file:1'); s.revision++;
  h.dispose(); fs.writeFileSync(file, JSON.stringify(s)); h.activate();
  const state = h.state();
  assert.deepEqual(state.propositions.map(p => [p.id, p.archived]), [['p1', false], ['file:1', false]]);
  assert.equal(Object.hasOwn(state.settings, 'modelOverride'), false, 'retired keys are not exposed');
  assert.deepEqual(state.statistics.states, { new: 2, learning: 0, review: 0, relearning: 0 });
  const first = await h.grade({ deckIds: [state.decks[0].id] }, 3);
  const second = await h.grade({ deckIds: [state.decks[0].id] }, 3);
  assert.deepEqual([first.propositionId, second.propositionId].sort(), ['file:1', 'p1']);
  const added = await h.call('create-cue', { propositionId: 'p1', question: 'Hand-written follow-up', answer: 'B', requestId: 'add-legacy' });
  assert.equal(added.state.propositions.find(p => p.id === 'p1').cues.length, 2);
});

test('cue filters are strict for empty, unknown or deleted selections and reject invalid shapes', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Deleted', 'Active'), cards('p2', 'Other'));
  const p = h.state().propositions[0];
  await h.call('delete-cue', { propositionId: p.id, cueId: p.cues[0].id, version: p.version });
  const before = h.disk();
  for (const cueIds of [[], ['missing'], [p.cues[0].id]]) {
    assert.deepEqual(await h.call('next-review', { cueIds }), { ticket: null, remaining: 0 });
  }
  for (const cueIds of [null, p.cues[1].id, {}, [1], [p.cues[1].id, false], [[p.cues[1].id]]]) {
    await assert.rejects(h.call('next-review', { cueIds }), /Invalid cue selection/);
  }
  for (const scope of [{ deckIds: [] }, { propositionIds: [] }]) {
    assert.equal((await h.call('next-review', { ...scope, cueIds: [p.cues[1].id] })).ticket, null);
  }
  assert.ok((await h.call('next-review', { cueIds: [p.cues[1].id] })).ticket, 'cards stay live without a graph');
  assert.ok((await h.call('next-review')).ticket);
  assert.deepEqual(h.disk(), before);
});

for (const mode of ['learning', 'relearning']) test(`${mode} cue filtering skips active excluded pins, including nextDue, but deleted pins fall back to selected cues`, async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Pinned', 'Excluded fallback', 'Selected fallback'), cards('p2', 'New proposition'));
  const [initial, other] = h.state().propositions;
  const [pinned, excluded, fallback] = initial.cues;
  if (mode === 'relearning') {
    await h.grade({ cueIds: [pinned.id] }, 4);
    now += 30 * 86400000;
  }
  await h.grade({ cueIds: [pinned.id] }, 1);
  const p = h.state().propositions[0], due = p.schedule.due;
  assert.equal(p.schedule.state, mode === 'learning' ? 1 : 3);
  assert.equal(p.learningCueId, pinned.id);
  assert.deepEqual(await h.call('next-review', { cueIds: [fallback.id] }), { ticket: null, remaining: 0 });
  assert.deepEqual(await h.call('next-review', { cueIds: [] }), { ticket: null, remaining: 0 });
  assert.equal((await h.call('next-review', { cueIds: [pinned.id] })).nextDue, due);
  assert.equal((await h.call('next-review', { propositionIds: ['p1'] })).nextDue, due);
  now = due;
  const before = h.disk();
  assert.equal((await h.call('next-review', { cueIds: [fallback.id] })).ticket, null);
  assert.equal((await h.call('next-review', { propositionIds: ['p1'] })).ticket.cueId, pinned.id);
  assert.equal((await h.call('next-review', { cueIds: [pinned.id, fallback.id] })).ticket.cueId, pinned.id);
  assert.equal((await h.call('next-review', { cueIds: [fallback.id, other.cues[0].id] })).ticket.propositionId, 'p2');
  assert.deepEqual(h.disk(), before);
  await h.call('delete-cue', { propositionId: 'p1', cueId: pinned.id, version: p.version });
  const ticket = await h.grade({ cueIds: [fallback.id] }, 1);
  assert.equal(ticket.cueId, fallback.id);
  const after = h.state().propositions[0];
  assert.equal(after.learningCueId, fallback.id);
  assert.equal(after.cues.find(c => c.id === excluded.id).latestRating, null);
  assert.equal(after.schedule.reps, p.schedule.reps + 1);
  assert.equal(h.disk().reviews.filter(r => r.introduced).length, 1);
});

test('remaining combines ready due and admissible new propositions, excluding future learning and unselected active pins', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('learning', 'review', 'future', 'new1', 'new2'));
  await h.generate(cards('learning', 'Pinned', 'Alternate'), cards('review', 'Due review'), cards('future', 'Future learning'), cards('new1', 'New one'), cards('new2', 'New two'));
  await h.grade({ propositionIds: ['review'] }, 4);
  now += 30 * 86400000;
  await h.grade({ propositionIds: ['learning'] }, 1);
  now += 60000;
  await h.grade({ propositionIds: ['future'] }, 1);
  await h.call('save-deck', { id: h.state().decks[0].id, newLimit: 3 });
  const before = h.disk();
  const result = await h.call('next-review');
  assert.equal(result.ticket.propositionId, 'learning', 'actual learning-first selection is unchanged');
  assert.equal(result.remaining, 3, 'two due plus one introduction, including current');
  assert.equal((await h.call('next-review', { propositionIds: ['learning', 'review', 'future'] })).remaining, 2);
  assert.equal((await h.call('next-review', { propositionIds: ['learning', 'future', 'new1'] })).remaining, 2);
  const future = h.state().propositions.find(p => p.id === 'future');
  assert.deepEqual(await h.call('next-review', { propositionIds: ['future'] }), { ticket: null, nextDue: future.schedule.due, remaining: 0 });
  const learning = h.state().propositions.find(p => p.id === 'learning');
  const alternate = learning.cues.find(c => c.id !== learning.learningCueId);
  const newCue = h.state().propositions.find(p => p.id === 'new1').cues[0];
  assert.equal((await h.call('next-review', { cueIds: [alternate.id, future.cues[0].id, newCue.id] })).remaining, 1);
  assert.deepEqual(await h.call('next-review', { cueIds: [] }), { ticket: null, remaining: 0 });
  assert.deepEqual(h.disk(), before);
  await h.call('delete-cue', { propositionId: learning.id, cueId: learning.learningCueId, version: learning.version });
  assert.equal((await h.call('next-review', { cueIds: [alternate.id, newCue.id] })).remaining, 2, 'deleted pin falls back within the selected pool');
  await h.call('save-deck', { id: h.state().decks[0].id, newLimit: 0 });
  assert.equal((await h.call('next-review')).remaining, 2, 'ready due obligations are uncapped even when new admissions are zero');
});

test('get-state adds read-only aggregate statistics, deduplicating shared propositions and retaining deleted review activity', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'First cue', 'Second cue'), cards('p2', 'Other cue'));
  await h.call('create-deck', { name: 'Shared' });
  await h.call('set-memberships', { propositionId: 'p1', deckIds: h.state().decks.map(d => d.id) });
  let stats = h.state().statistics;
  assert.deepEqual(stats.states, { new: 2, learning: 0, review: 0, relearning: 0 });
  assert.equal(stats.due.length, 9); assert.equal(stats.activity.length, 14);
  await h.grade({ propositionIds: ['p1'] }, 1);
  stats = h.state().statistics;
  assert.deepEqual(stats.states, { new: 1, learning: 1, review: 0, relearning: 0 });
  assert.equal(stats.due[1].count, 1, 'future learning later today is in the today bar');
  assert.equal(stats.activity.at(-1).count, 1);
  const p2 = h.state().propositions.find(p => p.id === 'p2');
  await h.call('delete-cue', { propositionId: p2.id, cueId: p2.cues[0].id, version: p2.version });
  const before = h.disk(), state = await h.call('get-state');
  assert.deepEqual(state.statistics.states, { new: 0, learning: 1, review: 0, relearning: 0 });
  assert.equal(state.statistics.activity.at(-1).count, 1);
  assert.equal(Object.hasOwn(state, 'reviews'), false);
  assert.deepEqual(h.disk(), before);
});

test('decks expose Anki-style counts for today: admissible new, learning due now, reviews due', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('a', 'b', 'c', 'd'));
  await h.generate(cards('a', 'A'), cards('b', 'B'), cards('c', 'C'), cards('d', 'D'));
  const deckId = h.state().decks[0].id;
  assert.deepEqual(h.state().decks[0].counts, { new: 4, learn: 0, review: 0 });
  await h.call('save-deck', { id: deckId, newLimit: 3 });
  assert.deepEqual(h.state().decks[0].counts, { new: 3, learn: 0, review: 0 }, 'new is capped by the daily limit');
  await h.grade({ propositionIds: ['a'] }, 1);   // Again: learning step, due in a minute
  assert.deepEqual(h.state().decks[0].counts, { new: 2, learn: 0, review: 0 }, 'the introduction used one new slot; the step is not due yet');
  now += 10 * 60000;
  assert.deepEqual(h.state().decks[0].counts, { new: 2, learn: 1, review: 0 });
  await h.grade({ propositionIds: ['b'] }, 4);   // Easy: graduates to review
  now += 60 * 86400000;
  const counts = h.state().decks[0].counts;
  assert.equal(counts.review, 1, 'the graduated card is due again much later');
});
