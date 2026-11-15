'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { openStore } = require('./store.cjs');
const scheduler = require('./scheduler.cjs');
const { statistics } = require('./statistics.cjs');

// Flashcards in the M3Kang practice build: decks, hand-written cards and FSRS
// review, all local. Generation from the knowledge graph or from documents is
// gone with those sources; no model is called. Cards created by earlier
// generation stay in the store and remain reviewable.
const fingerprint = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const memberships = (s, id) => s.decks.filter(d => d.propositionIds.includes(id)).map(d => d.id);
const reviewConfiguration = s => fingerprint({ retention: s.retention, learningSteps: s.learningSteps, relearningSteps: s.relearningSteps, dayStart: s.dayStart, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const fail = (message) => { throw new Error(message); };
function requiredText(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} must not be blank.`); return value; }
// Keys kept by older builds (generation budget, model overrides) are dropped on save.
const RETIRED_SETTINGS = ['chunkBudget', 'modelOverride', 'thinkingOverride'];
function validateSettings(patch, old) {
  const allowed = new Set(['retention', 'learningSteps', 'relearningSteps', 'dayStart']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`Unsupported setting: ${key}`);
  const s = { ...old, ...patch };
  for (const key of RETIRED_SETTINGS) delete s[key];
  if (!Number.isFinite(s.retention) || s.retention < .7 || s.retention > .99) fail('Desired retention must be between 70% and 99%.');
  for (const key of ['learningSteps', 'relearningSteps']) {
    if (!Array.isArray(s[key]) || !s[key].length || s[key].some((v, i, a) => !Number.isSafeInteger(v) || v < 1 || v >= 1440 || (i > 0 && v <= a[i - 1]))) fail('Use nonempty, increasing whole-minute steps shorter than one day.');
  }
  if (!Number.isInteger(s.dayStart) || s.dayStart < 0 || s.dayStart > 23) fail('Study-day start must be a whole hour from 0 to 23.');
  return s;
}

function activate(ctx) {
  const store = openStore(ctx.dataDirectory);
  const tickets = new Map();
  let disposed = false, sourceCleanupError = null;
  const alive = () => { if (disposed || ctx.signal.aborted) fail('Flashcards is disabled.'); };
  const notify = (topic = 'changed') => { if (!disposed && !ctx.signal.aborted) ctx.events.emit(topic); };
  function change(update, topic) { alive(); const result = store.change(update); notify(topic); return result; }
  // Commit metadata removal first; a durable queue makes file cleanup retryable
  // after unlink/save failures without resurrecting decks or source records.
  function finishSourceCleanup() {
    const pending = store.get().pendingSourceRemovals ?? [];
    if (!pending.length) { sourceCleanupError = null; return; }
    try {
      for (const id of pending) store.removeSource(id);
      change(s => { delete s.pendingSourceRemovals; });
      sourceCleanupError = null;
    } catch (error) {
      sourceCleanupError = `Content was deleted, but saved-file cleanup is pending: ${error.message}. Retry deletion or reload Flashcards to finish cleanup.`;
      throw new Error(sourceCleanupError);
    }
  }
  try { finishSourceCleanup(); } catch { /* expose pending cleanup in the view; retry on deletion or next activation */ }
  const prop = (s, id) => Object.hasOwn(s.propositions, id) ? s.propositions[id] : fail('Proposition not found.');
  const deck = (s, id) => s.decks.find(d => d.id === id) ?? fail('Deck not found.');
  // Every stored target is live: there is no graph left to archive against.
  function liveIds(s) { return new Set(Object.keys(s.propositions)); }
  function counts(s, now) {
    const { start, end } = scheduler.dayBounds(now, s.settings.dayStart);
    const result = Object.fromEntries(s.decks.map(d => [d.id, 0]));
    for (const review of s.reviews) if (review.introduced && review.at >= start && review.at < end) for (const id of review.deckIds) if (id in result) result[id]++;
    return result;
  }
  function view() {
    alive(); const s = store.get(), live = liveIds(s), now = Date.now();
    const newCounts = counts(s, now);
    const propositions = Object.values(s.propositions).map(p => ({ ...p, memberships: memberships(s, p.id), archived: false }));
    const decks = s.decks.map(d => {
      const members = propositions.filter(p => d.propositionIds.includes(p.id) && p.cues.some(c => !c.deleted));
      const ready = p => scheduler.isDue(p.schedule, now, s.settings.dayStart);
      // Anki-style counts for today: new still admissible under the deck's daily
      // limit, learning/relearning steps that are due now, and due reviews.
      const counts = {
        new: Math.min(members.filter(p => p.schedule.state === 0).length, Math.max(0, d.newLimit - newCounts[d.id])),
        learn: members.filter(p => [1, 3].includes(p.schedule.state) && ready(p)).length,
        review: members.filter(p => p.schedule.state === 2 && ready(p)).length,
      };
      return { ...d, newToday: newCounts[d.id], due: members.filter(p => p.schedule.state !== 0 && ready(p)).length, counts };
    });
    const settings = { ...s.settings }; for (const key of RETIRED_SETTINGS) delete settings[key];
    return { revision: s.revision, settings, decks, propositions, batch: null, statistics: statistics(s, live, now), ...(sourceCleanupError ? { cleanupError: sourceCleanupError } : {}) };
  }
  function register(name, handler) { ctx.handle(name, (input = {}) => { alive(); if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid operation input.'); return handler(input); }); }
  register('get-state', view);
  register('save-settings', patch => { change(s => { s.settings = validateSettings(patch, s.settings); }); return view(); });
  register('create-deck', ({ name }) => { change(s => s.decks.push({ id: randomUUID(), name: requiredText(name, 'Deck name').trim(), newLimit: 20, propositionIds: [] })); return view(); });
  function createManualCard(input, newTarget) {
    const requestId = requiredText(input.requestId, 'Request ID');
    const question = requiredText(input.question, 'Question'), answer = requiredText(input.answer, 'Answer');
    const destination = newTarget
      ? { deckId: requiredText(input.deckId, 'Deck ID'), name: requiredText(input.name, 'Name').trim() }
      : { propositionId: requiredText(input.propositionId, 'Target ID') };
    const hash = fingerprint({ kind: newTarget ? 'create-card' : 'create-cue', ...destination, question, answer });
    const prior = store.get().creationReceipts?.find(r => r.requestId === requestId);
    if (prior) {
      if (prior.hash !== hash) fail('This request ID was already used for different work.');
      return { state: view(), propositionId: prior.propositionId, cueId: prior.cueId };
    }
    const created = change(s => {
      let p;
      if (newTarget) {
        const d = deck(s, destination.deckId);
        p = { id: `manual:${randomUUID()}`, origin: 'manual', name: destination.name, statement: '', cues: [], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
        s.propositions[p.id] = p; d.propositionIds.push(p.id);
      } else {
        p = prop(s, destination.propositionId);
      }
      const cue = { id: randomUUID(), question, answer, latestRating: null };
      p.cues.push(cue); p.version++;
      s.creationReceipts ??= [];
      s.creationReceipts.push({ requestId, hash, propositionId: p.id, cueId: cue.id });
      return { propositionId: p.id, cueId: cue.id };
    });
    return { state: view(), ...created };
  }
  register('create-card', input => createManualCard(input, true));
  register('create-cue', input => createManualCard(input, false));
  register('save-deck', patch => {
    change(s => {
      const d = deck(s, patch.id);
      if (Object.hasOwn(patch, 'name')) d.name = requiredText(patch.name, 'Deck name').trim();
      if (Object.hasOwn(patch, 'newLimit')) { if (!Number.isSafeInteger(patch.newLimit) || patch.newLimit < 0) fail('Daily limit must be a nonnegative safe whole number.'); d.newLimit = patch.newLimit; }
      for (const source of Object.values(s.fileSources ?? {})) if (source.deckId === d.id) { source.deckName = d.name; source.newLimit = d.newLimit; }
    }); return view();
  });
  function deleteContent(input) {
    const requestId = requiredText(input.requestId, 'Request ID');
    const ids = key => {
      const values = input[key] === undefined ? [] : input[key];
      if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !id.trim())) fail(`Invalid ${key} deletion selection.`);
      return [...new Set(values)].sort();
    };
    const scope = { deckIds: ids('deckIds'), propositionIds: ids('propositionIds'), cueIds: ids('cueIds'), deleteEmptyDecks: input.deleteEmptyDecks, revision: input.revision };
    if (typeof scope.deleteEmptyDecks !== 'boolean' || !Number.isSafeInteger(scope.revision)) fail('Invalid deletion options.');
    if (!scope.deckIds.length && !scope.propositionIds.length && !scope.cueIds.length) fail('Select content to delete.');
    const hash = fingerprint(scope), prior = store.get().deletionReceipts?.find(r => r.requestId === requestId);
    if (prior) {
      if (prior.hash !== hash) fail('This request ID was already used for different work.');
      finishSourceCleanup(); return view();
    }
    change(s => {
      if (s.revision !== scope.revision) fail('The library changed. Reload and confirm the deletion again.');
      const whole = new Set(scope.propositionIds), cueIds = new Set(scope.cueIds), affectedDecks = new Set(scope.deckIds);
      for (const id of scope.deckIds) for (const pid of deck(s, id).propositionIds) whole.add(pid);
      for (const id of whole) prop(s, id);
      const owners = new Map(Object.values(s.propositions).flatMap(p => p.cues.map(c => [c.id, p.id])));
      for (const id of cueIds) if (!owners.has(id)) fail('Selected card no longer exists.');
      const affected = new Set([...whole, ...[...cueIds].map(id => owners.get(id))]);
      for (const id of affected) {
        const p = prop(s, id);
        for (const deckId of memberships(s, id)) affectedDecks.add(deckId);
        p.cues = whole.has(id) ? [] : p.cues.filter(c => !cueIds.has(c.id));
        if (!p.cues.length) {
          delete s.propositions[id];
          for (const d of s.decks) d.propositionIds = d.propositionIds.filter(pid => pid !== id);
        } else {
          if (!p.cues.some(c => c.id === p.learningCueId)) p.learningCueId = null;
          p.version++;
        }
      }
      if (scope.deleteEmptyDecks) s.decks = s.decks.filter(d => !affectedDecks.has(d.id) || d.propositionIds.length);
      for (const source of Object.values(s.fileSources ?? {})) if (!s.decks.some(d => d.id === source.deckId)) {
        // Only decks removed by this action own the sources being cleaned up.
        if (!affectedDecks.has(source.deckId) || !scope.deleteEmptyDecks) continue;
        delete s.fileSources[source.id];
        s.pendingSourceRemovals ??= [];
        if (!s.pendingSourceRemovals.includes(source.id)) s.pendingSourceRemovals.push(source.id);
      }
      s.deletionReceipts ??= []; s.deletionReceipts.push({ requestId, hash });
    });
    finishSourceCleanup(); return view();
  }
  register('delete-content', deleteContent);
  register('delete-deck', ({ id, replacementDeckId }) => {
    if (replacementDeckId !== undefined) fail('Replacement decks are no longer used. Reload Flashcards.');
    return deleteContent({ deckIds: [id], deleteEmptyDecks: true, revision: store.get().revision, requestId: randomUUID() });
  });
  register('set-memberships', ({ propositionId, deckIds }) => {
    change(s => {
      if (!Array.isArray(deckIds) || !deckIds.length || deckIds.some(id => typeof id !== 'string')) fail('Keep at least one deck membership.');
      const selected = new Set(deckIds); for (const id of selected) deck(s, id);
      const p = prop(s, propositionId);
      for (const d of s.decks) { d.propositionIds = d.propositionIds.filter(id => id !== p.id || selected.has(d.id)); if (selected.has(d.id) && !d.propositionIds.includes(p.id)) d.propositionIds.push(p.id); }
      p.version++;
    }); return view();
  });
  register('save-cue', ({ propositionId, cueId, question, answer, version }) => {
    requiredText(question, 'Question'); requiredText(answer, 'Answer');
    change(s => { const p = prop(s, propositionId); if (p.version !== version) fail('This card changed elsewhere. Reload before saving.'); const c = p.cues.find(c => c.id === cueId && !c.deleted) ?? fail('Card not found.'); c.question = question; c.answer = answer; p.version++; }); return view();
  });
  register('delete-cue', ({ propositionId, cueId, version }) => {
    const p = prop(store.get(), propositionId);
    if (p.version !== version) fail('This card changed elsewhere. Reload before deleting.');
    if (!p.cues.some(c => c.id === cueId)) fail('Card not found.');
    return deleteContent({ cueIds: [cueId], deleteEmptyDecks: true, revision: store.get().revision, requestId: randomUUID() });
  });
  register('reorder', ({ kind, id, deckId, propositionId, direction }) => {
    if (![-1, 1].includes(direction)) fail('Invalid order direction.');
    const live = kind === 'proposition' ? liveIds(store.get()) : null;
    change(s => {
      const list = kind === 'deck' ? s.decks : kind === 'proposition' ? deck(s, deckId).propositionIds : kind === 'cue' ? prop(s, propositionId).cues : fail('Invalid order kind.');
      const positions = list.flatMap((x, i) => (kind === 'cue' ? !x.deleted : kind === 'proposition' ? live.has(x) : true) ? [i] : []);
      const index = positions.findIndex(i => (typeof list[i] === 'string' ? list[i] : list[i].id) === id);
      if (index < 0) fail('Item not found.');
      const other = index + direction;
      if (other >= 0 && other < positions.length) { const a = positions[index], b = positions[other]; [list[a], list[b]] = [list[b], list[a]]; }
    }); return view();
  });
  function scopeIds(s, scope) {
    if (scope.deckIds !== undefined && (!Array.isArray(scope.deckIds) || scope.deckIds.some(id => !s.decks.some(d => d.id === id)))) fail('Selected deck no longer exists.');
    if (scope.propositionIds !== undefined && !Array.isArray(scope.propositionIds)) fail('Invalid review selection.');
    if (scope.cueIds !== undefined && (!Array.isArray(scope.cueIds) || scope.cueIds.some(id => typeof id !== 'string'))) fail('Invalid cue selection: use an array of cue IDs.');
    const ds = scope.deckIds ? s.decks.filter(d => scope.deckIds.includes(d.id)) : s.decks;
    let ids = [...new Set(ds.flatMap(d => d.propositionIds))];
    if (scope.propositionIds) ids = ids.filter(id => scope.propositionIds.includes(id));
    return { decks: ds, ids };
  }
  function reviewCues(p, scope) {
    const active = p.cues.filter(c => !c.deleted);
    if (scope.cueIds === undefined) return active;
    const pinned = [1, 3].includes(p.schedule.state) && active.find(c => c.id === p.learningCueId);
    // Do not switch away from an active learning cue just because it is unselected.
    if (pinned && !scope.cueIds.includes(pinned.id)) return [];
    return active.filter(c => scope.cueIds.includes(c.id));
  }
  function validTicket(id, mustReveal = false, now = Date.now()) {
    const t = tickets.get(id) ?? fail('This review expired. Load the next card.');
    const s = store.get(), p = prop(s, t.propositionId);
    if (p.version !== t.version || reviewConfiguration(s.settings) !== t.settingsHash || scheduler.studyDay(now, s.settings.dayStart) !== t.day) fail('This review changed elsewhere. Load the next card.');
    const { ids } = scopeIds(s, t.scope);
    if (!ids.includes(p.id)) fail('The review selection changed. Load the next card.');
    const c = reviewCues(p, t.scope).find(c => c.id === t.cueId) ?? fail('This card is no longer available in the review selection.');
    if (mustReveal && !t.revealed) fail('Reveal the answer before rating.');
    if (p.schedule.state === 0) { const d = deck(s, t.admittingDeckId); if (counts(s, now)[d.id] >= d.newLimit) fail('The new-proposition limit has been reached for this deck.'); }
    else if (!scheduler.isDue(p.schedule, now, s.settings.dayStart)) fail('This proposition is not due.');
    return { t, p, c, s };
  }
  register('next-review', scope => {
    const s = store.get(), live = liveIds(s), now = Date.now();
    const selection = scopeIds(s, scope), used = counts(s, now);
    const candidates = selection.ids.map(id => s.propositions[id]).filter(p => p && live.has(p.id) && reviewCues(p, scope).length);
    const ready = candidates.filter(p => p.schedule.state !== 0 && scheduler.isDue(p.schedule, now, s.settings.dayStart));
    ready.sort((a, b) => ((a.schedule.state === 1 || a.schedule.state === 3) ? 0 : 1) - ((b.schedule.state === 1 || b.schedule.state === 3) ? 0 : 1) || a.schedule.due - b.schedule.due);
    let p = ready[0], admittingDeckId = null;
    if (!p) {
      for (const d of selection.decks) {
        if (used[d.id] >= d.newLimit) continue;
        p = candidates.find(p => p.schedule.state === 0 && d.propositionIds.includes(p.id));
        if (p) { admittingDeckId = d.id; break; }
      }
    }
    if (!p) {
      const future = candidates.filter(p => [1, 3].includes(p.schedule.state) && p.schedule.due > now).map(p => p.schedule.due);
      return { ticket: null, ...(future.length ? { nextDue: Math.min(...future) } : {}), remaining: 0 };
    }
    // Count introductions in the same deterministic admission order without
    // consuming allowances, changing schedules, or making additional cue choices.
    let remaining = ready.length;
    const simulated = { ...used }, introduced = new Set();
    for (const d of selection.decks) for (const candidate of candidates) {
      if (simulated[d.id] >= d.newLimit) break;
      if (candidate.schedule.state !== 0 || introduced.has(candidate.id) || !d.propositionIds.includes(candidate.id)) continue;
      introduced.add(candidate.id); remaining++;
      for (const id of memberships(s, candidate.id)) simulated[id]++;
    }
    const active = reviewCues(p, scope);
    const chosen = ([1, 3].includes(p.schedule.state) && active.find(c => c.id === p.learningCueId)) || scheduler.chooseCue(active);
    const id = randomUUID();
    tickets.set(id, { id, propositionId: p.id, cueId: chosen.id, version: p.version, settingsHash: reviewConfiguration(s.settings), day: scheduler.studyDay(now, s.settings.dayStart), scope: structuredClone(scope), admittingDeckId, revealed: false });
    return { ticket: { id, propositionId: p.id, cueId: chosen.id, question: chosen.question, propositionName: p.name }, remaining };
  });
  register('reveal-review', ({ ticketId }) => {
    const now = Date.now();
    const { t, p, c, s } = validTicket(ticketId, false, now); t.revealed = true;
    const previews = scheduler.preview(p.schedule, now, s.settings);
    return { answer: c.answer, intervals: Object.fromEntries([1, 2, 3, 4].map(r => [r, previews[r].state === 2 ? previews[r].scheduled_days * 86400000 : previews[r].due - now])) };
  });
  register('rate-review', ({ ticketId, rating, requestId }) => {
    requiredText(requestId, 'Request ID');
    const previous = store.get().reviews.find(r => r.requestId === requestId);
    if (previous) { if (previous.ticketId !== ticketId || previous.rating !== rating) fail('This request ID was already used for different work.'); return { ok: true }; }
    if (![1, 2, 3, 4].includes(rating)) fail('Invalid rating.');
    const now = Date.now(), { t } = validTicket(ticketId, true, now);
    change(s => {
      const p = prop(s, t.propositionId), c = p.cues.find(c => c.id === t.cueId);
      const before = p.schedule, introduced = p.firstReviewedAt == null;
      p.schedule = scheduler.rate(before, rating, now, s.settings);
      p.learningCueId = [1, 3].includes(p.schedule.state) ? c.id : null;
      p.firstReviewedAt ??= now; c.latestRating = rating; c.lastReviewedAt = now; p.version++;
      s.reviews.push({ id: randomUUID(), requestId, ticketId, propositionId: p.id, cueId: c.id, rating, at: now, before, after: p.schedule, introduced, deckIds: introduced ? memberships(s, p.id) : [], settings: structuredClone(s.settings) });
    });
    tickets.delete(ticketId); return { ok: true };
  });
  const cleanup = () => { disposed = true; tickets.clear(); };
  ctx.cleanup(cleanup);
}
module.exports = { activate, validateSettings };
