import { mountLibraryTree } from './library-tree.js';
import { createReviewController } from './review.js';
import { mountDashboard } from './dashboard.js';
import { mountDeckList } from './deck-list.js';
import { buildPracticeCards } from './practice-queue.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const message = error => error instanceof Error ? error.message : String(error);
const uuid = () => crypto.randomUUID();
const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
function lifetime(...parents) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents) { if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); }
  controller.signal.addEventListener('abort', () => { for (const parent of parents) parent.removeEventListener('abort', abort); }, { once: true });
  return controller;
}
function parseSteps(text) {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one learning step.');
  const values = parts.map(part => {
    const match = /^(\d+)(m|h)?$/i.exec(part);
    if (!match) throw new Error('Use whole minutes, separated by spaces or commas (for example 1m 10m).');
    return Number(match[1]) * (match[2]?.toLowerCase() === 'h' ? 60 : 1);
  });
  if (values.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || value >= 1440 || (index > 0 && value <= values[index - 1]))) throw new Error('Steps must be increasing positive whole minutes, each shorter than one day.');
  return values;
}

export function activate(ctx) {
  for (const capability of ['mountMarkdown', 'mountTree', 'openSurface', 'openMenu']) {
    if (typeof ctx.ui?.[capability] !== 'function') throw new Error(`Flashcards requires a newer LearnHarness host with ctx.ui.${capability}. Please update LearnHarness.`);
  }
  let snapshot = null, refreshing = null, refreshAgain = false;
  const observers = new Set(), registrations = [];
  const publish = value => {
    if (!value || ctx.signal.aborted || (snapshot && value.revision < snapshot.revision)) return;
    snapshot = value; for (const observer of observers) observer(value);
  };
  const report = error => { for (const observer of observers) observer(null, message(error)); };
  const refresh = () => {
    if (!observers.size || ctx.signal.aborted) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try { const state = await ctx.call('get-state'); if (observers.size) publish(state); }
        catch (error) { if (observers.size) report(error); }
      } while (refreshAgain && observers.size && !ctx.signal.aborted);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const observe = (fn, signal) => {
    observers.add(fn); signal.addEventListener('abort', () => observers.delete(fn), { once: true });
    if (snapshot) fn(snapshot); void refresh();
  };
  function widget(handle, signal) {
    if (signal.aborted) handle.dispose(); else signal.addEventListener('abort', () => handle.dispose(), { once: true });
    return handle;
  }
  function button(parent, label, action, signal, options = {}) {
    const slot = el('span', 'fc-button'); parent.append(slot);
    let pending = false, disabled = !!options.disabled;
    const handle = widget(ctx.ui.mountButton(slot, { label, size: 'sm', variant: 'outline', ...options, onClick: async () => {
      if (pending || signal.aborted || disabled) return;
      pending = true; handle.update({ disabled: true });
      try { await action(); } finally { pending = false; if (!signal.aborted) handle.update({ disabled }); }
    } }, { signal }), signal);
    return { update(props) { if (Object.hasOwn(props, 'disabled')) disabled = props.disabled; handle.update({ ...props, disabled: pending || disabled }); }, dispose: () => handle.dispose() };
  }
  function markdown(parent, text, signal) {
    const slot = el('div', 'fc-markdown'); parent.append(slot);
    return widget(ctx.ui.mountMarkdown(slot, { text: text || '' }, { signal }), signal);
  }
  async function mutate(operation, input, signal) {
    const value = await ctx.call(operation, input);
    if (signal.aborted) return false;
    publish(value); return true;
  }
  function field(parent, label, value, type = 'text') {
    const wrapper = el('label', 'fc-field'), input = el(type === 'textarea' ? 'textarea' : 'input', 'fc-input');
    if (type !== 'textarea') input.type = type;
    input.value = String(value ?? ''); wrapper.append(el('span', 'fc-label', label), input); parent.append(wrapper); return input;
  }
  function dialog(title, parentSignal, build, closeLabel = 'Cancel') {
    let handle;
    handle = ctx.ui.openDialog({ title, content: (container, hostSignal) => {
      const scope = lifetime(parentSignal, hostSignal, ctx.signal), root = el('div', 'fc-root fc-dialog');
      const error = el('p', 'fc-error'); error.setAttribute('role', 'alert');
      root.append(el('h2', 'fc-dialog-heading', title)); container.append(root);
      const actions = el('div', 'fc-actions');
      const run = action => async () => { try { await action(); } catch (cause) { if (!scope.signal.aborted) error.textContent = message(cause); } };
      build({ root, actions, signal: scope.signal, run, close: () => handle?.dispose() });
      root.append(error, actions); button(actions, closeLabel, () => handle?.dispose(), scope.signal, { variant: 'ghost' });
      return () => { scope.abort(); root.remove(); };
    } }, { signal: parentSignal });
    return widget(handle, parentSignal);
  }
  function cueFields(root, cue = {}) {
    return {
      question: field(root, 'Question (Markdown)', cue.question, 'textarea'),
      answer: field(root, 'Answer (Markdown)', cue.answer, 'textarea'),
    };
  }
  function createCard(deck, proposition, signal, onCreated) {
    const requestId = uuid();
    dialog(proposition ? 'Add cue' : 'Create card', signal, ({ root, actions, signal: ds, run, close }) => {
      const name = proposition ? null : field(root, 'Name', '');
      const { question, answer } = cueFields(root);
      button(actions, 'Save', run(async () => {
        const created = await ctx.call(proposition ? 'create-cue' : 'create-card', {
          ...(proposition ? { propositionId: proposition.id } : { deckId: deck.id, name: name.value }),
          question: question.value, answer: answer.value, requestId,
        });
        if (ds.aborted) return;
        publish(created.state); close(); onCreated(created);
      }), ds, { variant: 'default' });
    });
  }
  function editCue(proposition, cue, signal) {
    dialog('Edit cue', signal, ({ root, actions, signal: ds, run, close }) => {
      const { question, answer } = cueFields(root, cue);
      button(actions, 'Save', run(async () => { if (await mutate('save-cue', { propositionId: proposition.id, cueId: cue.id, question: question.value, answer: answer.value, version: proposition.version }, ds)) close(); }), ds, { variant: 'default' });
    });
  }
  function deleteContents(scope, signal) {
    const state = snapshot;
    if (!state) return;
    const whole = new Set(scope.propositionIds ?? []);
    for (const d of state.decks) if (scope.deckIds?.includes(d.id)) for (const id of d.propositionIds) whole.add(id);
    const selected = new Set(scope.cueIds ?? []);
    const count = state.propositions.reduce((n, p) => n + p.cues.filter(c => !c.deleted && (whole.has(p.id) || selected.has(c.id))).length, 0);
    const request = { ...structuredClone(scope), revision: state.revision, requestId: uuid() };
    dialog('Delete flashcards?', signal, ({ root, actions, signal: ds, run, close }) => {
      const description = el('div', 'fc-muted fc-delete-description'); root.append(description);
      markdown(description, `${count} ${count === 1 ? 'cue' : 'cues'} will be deleted from every deck. Targets with no remaining cues and their schedules will be removed. Past review statistics are kept.`, ds);
      const label = el('label', 'fc-check'), emptyDecks = el('input'); emptyDecks.type = 'checkbox'; emptyDecks.checked = true;
      label.append(emptyDecks, document.createTextNode('Delete empty decks too')); root.append(label);
      let submitted;
      button(actions, 'Delete', run(async () => {
        submitted ??= { ...request, deleteEmptyDecks: emptyDecks.checked };
        emptyDecks.disabled = true;
        if (await mutate('delete-content', submitted, ds)) close();
      }), ds, { variant: 'destructive' });
    });
  }
  function deleteCue(proposition, cue, signal) { deleteContents({ cueIds: [cue.id] }, signal); }
  function previewCue(proposition, cue, archive, signal) {
    dialog(proposition.name, signal, ({ root, actions, signal: ds, close }) => {
      root.classList.add('fc-preview-dialog');
      const card = el('div', 'fc-review-card fc-preview-card'), answer = el('div', 'fc-answer');
      markdown(card, cue.question, ds); markdown(answer, cue.answer, ds);
      card.append(answer); root.append(card);
      if (!archive) {
        button(actions, 'Edit', () => { close(); editCue(proposition, cue, signal); }, ds);
        button(actions, 'Delete', () => { close(); deleteCue(proposition, cue, signal); }, ds, { variant: 'destructive' });
      }
    }, 'Close');
  }
  function memberships(proposition, state, signal) {
    dialog('Deck memberships', signal, ({ root, actions, signal: ds, run, close }) => {
      root.append(el('p', 'fc-muted', 'Memberships share the same cues, schedule, and history. Keep at least one deck.'));
      const choices = state.decks.map(deck => {
        const label = el('label', 'fc-check'), input = el('input'); input.type = 'checkbox'; input.checked = proposition.memberships.includes(deck.id);
        label.append(input, document.createTextNode(deck.name)); root.append(label); return { id: deck.id, input };
      });
      button(actions, 'Save memberships', run(async () => {
        const deckIds = choices.filter(choice => choice.input.checked).map(choice => choice.id);
        if (!deckIds.length) throw new Error('Choose at least one deck.');
        if (await mutate('set-memberships', { propositionId: proposition.id, deckIds }, ds)) close();
      }), ds, { variant: 'default' });
    });
  }
  function editDeck(deck, signal) {
    dialog(deck ? 'Deck settings' : 'Create deck', signal, ({ root, actions, signal: ds, run, close }) => {
      const name = field(root, 'Deck name', deck?.name || ''), limit = deck ? field(root, 'New propositions per day', deck.newLimit, 'number') : null;
      if (limit) { limit.min = '0'; limit.step = '1'; }
      button(actions, deck ? 'Save' : 'Create', run(async () => {
        if (!name.value.trim()) throw new Error('Enter a deck name.');
        const input = deck ? { id: deck.id, name: name.value, newLimit: Number(limit.value) } : { name: name.value };
        if (await mutate(deck ? 'save-deck' : 'create-deck', input, ds)) close();
      }), ds, { variant: 'default' });
      if (deck) {
        button(actions, 'Delete deck…', () => { close(); deleteContents({ deckIds: [deck.id] }, signal); }, ds, { variant: 'destructive' });
      }
    });
  }

  function mountLibrary(container, hostSignal) {
    const view = lifetime(hostSignal, ctx.signal), signal = view.signal;
    const root = el('div', 'fc-root fc-library'), toolbar = el('div', 'fc-toolbar'), error = el('p', 'fc-error');
    error.setAttribute('role', 'alert');
    const showError = text => { if (!signal.aborted) error.textContent = text; };
    const guarded = action => async () => { try { await action(); } catch (cause) { showError(message(cause)); } };
    const review = createReviewController({ ctx, signal, button, markdown, onRated: () => { void refresh(); } });
    const practice = scope => review.openPractice(buildPracticeCards(snapshot, scope));
    let cleanupMessage = null;
    const deckPanel = el('section', 'fc-deck-panel'), deckToolbar = el('div', 'fc-deck-toolbar');
    deckPanel.setAttribute('aria-label', 'Decks');
    const searchLabel = el('label', 'fc-search'), search = el('input', 'fc-input');
    search.type = 'search'; search.placeholder = 'Search decks, propositions, and cues'; search.setAttribute('aria-label', 'Search flashcards'); searchLabel.append(search);
    const selectionActions = el('div', 'fc-actions fc-selection-actions'), selectionCount = el('span', 'fc-muted'), treeSlot = el('div', 'fc-tree');
    const scopeActions = el('div', 'fc-actions fc-scope-actions'), selectionSummary = el('div', 'fc-selection-summary');
    selectionSummary.append(selectionCount); selectionActions.append(scopeActions, selectionSummary);
    let selection = { cueIds: [], propositionIds: [], count: 0 }, tree, hasPracticeCards = false;
    const currentScope = () => selection.count ? { cueIds: [...selection.cueIds], propositionIds: [...selection.propositionIds] } : {};
    const reviewAction = button(scopeActions, 'Review all', () => review.open(currentScope()), signal);
    const practiceAction = button(scopeActions, 'Practice all', () => practice(currentScope()), signal, { disabled: true });
    const deleteSlot = el('span', 'fc-delete-selected');
    const deleteAction = button(deleteSlot, 'Delete selected', () => deleteContents({ cueIds: [...selection.cueIds], propositionIds: [...selection.emptyPropositionIds], deckIds: [...selection.emptyDeckIds] }, signal), signal, { icon: trashIcon, iconOnly: true, size: 'icon-sm', variant: 'ghost', title: 'Delete selected' });
    const clearSelection = button(selectionSummary, 'Clear', () => tree.clearSelection(), signal, { variant: 'ghost', disabled: true });
    const updateSelection = () => {
      const selected = selection.count > 0;
      selectionCount.textContent = `${selection.count} selected`;
      reviewAction.update({ label: selected ? 'Review selected' : 'Review all', disabled: selected && !selection.cueIds.length });
      practiceAction.update({ label: selected ? 'Practice selected' : 'Practice all', disabled: selected ? !selection.cueIds.length : !hasPracticeCards });
      deleteAction.update({ disabled: !selected, title: 'Delete selected' });
      if (selected) scopeActions.append(deleteSlot); else deleteSlot.remove();
      clearSelection.update({ disabled: !selected });
    };
    updateSelection();
    deckToolbar.append(searchLabel);
    deckPanel.append(deckToolbar, selectionActions, treeSlot);
    // Anki-style: decks with today's counts first, then the two charts; the
    // full card tree (edit, delete, memberships, selection) stays one click away.
    const deckSlot = el('div', 'fc-deck-slot'), dashboardSlot = el('div', 'fc-dashboard-slot');
    const browse = el('details', 'fc-browse'), browseSummary = el('summary', 'fc-browse-summary', 'Browse cards');
    browse.append(browseSummary, deckPanel);
    root.append(toolbar, error, deckSlot, dashboardSlot, browse); container.append(root);
    const deckList = mountDeckList({ container: deckSlot, signal, button,
      onStudy: deck => review.open({ deckIds: [deck.id] }),
      onAddCard: deck => createCard(deck, null, signal, created => revealCreatedCard(created, deck.id)),
      onSettings: deck => editDeck(deck, signal),
      onCreateDeck: () => editDeck(null, signal),
    });
    const dashboard = mountDashboard({ container: dashboardSlot, signal, compact: true });
    tree = mountLibraryTree({ ctx, container: treeSlot, signal, button,
      onReview: scope => review.open(scope), onPreview: (p, cue, archive) => previewCue(p, cue, archive, signal),
      onEdit: (p, cue) => editCue(p, cue, signal), onDelete: (p, cue) => deleteCue(p, cue, signal),
      onCreateCard: deck => createCard(deck, null, signal, created => revealCreatedCard(created, deck.id)),
      onCreateCue: (p, deck) => createCard(deck, p, signal, created => revealCreatedCard(created, deck.id)),
      onDeckSettings: deck => editDeck(deck, signal), onMemberships: p => memberships(p, snapshot, signal),
      onReorder: input => mutate('reorder', input, signal), onRename: (id, name) => mutate('save-deck', { id, name }, signal),
      onSelection: value => { selection = value; updateSelection(); }, onError: showError,
    });
    const revealDeck = (id, propositionId) => {
      if (signal.aborted || !id) return;
      search.value = ''; tree.update(snapshot, ''); tree.revealDeck(id, propositionId);
    };
    const revealCreatedCard = (created, preferredDeckId) => {
      if (signal.aborted) return;
      const p = snapshot.propositions.find(p => p.id === created.propositionId);
      if (!p) return;
      revealDeck(p.memberships.includes(preferredDeckId) ? preferredDeckId : p.memberships[0], p.id);
    };
    search.addEventListener('input', () => { if (snapshot) tree.update(snapshot, search.value); }, { signal });
    observe((state, loadError) => {
      if (signal.aborted) return; if (loadError) { showError(loadError); return; }
      if (state.cleanupError) { cleanupMessage = state.cleanupError; showError(cleanupMessage); }
      else if (cleanupMessage && error.textContent === cleanupMessage) { error.textContent = ''; cleanupMessage = null; }
      tree.update(state, search.value); deckList.update(state);
      hasPracticeCards = state.propositions.some(p => !p.archived && p.cues.some(c => !c.deleted)); updateSelection();
      dashboard.update(state.statistics);
    }, signal);
    return () => { view.abort(); review.dispose(); tree.dispose(); deckList.dispose(); dashboard.dispose(); root.remove(); };
  }

  function mountSettings(container, hostSignal) {
    const scope = lifetime(hostSignal, ctx.signal), signal = scope.signal;
    const root = el('div', 'fc-root fc-settings'), error = el('p', 'fc-error'), fields = el('div');
    error.setAttribute('role', 'alert'); root.append(fields, error); container.append(root);
    let rows;
    const showError = cause => { if (!signal.aborted) error.textContent = message(cause); };
    const save = async patch => {
      try { const state = await ctx.call('save-settings', patch); if (signal.aborted) return; error.textContent = ''; publish(state); rows?.update({ rows: settingsRows(snapshot.settings) }); }
      catch (cause) { showError(cause); throw cause; }
    };
    const settingsRows = settings => {
      const row = (key, label, value, type, parse = value => value, extras = {}) => ({ key, label, value, type, ...extras, onChange: async value => { try { await save({ [key]: parse(value) }); } catch (cause) { showError(cause); throw cause; } } });
      return [
        row('retention', 'Desired retention (%)', settings.retention * 100, 'number', value => Number(value) / 100, { min: 70, max: 99, step: 1 }),
        row('learningSteps', 'Learning steps (minutes)', settings.learningSteps.map(value => `${value}m`).join(' '), 'text', parseSteps),
        row('relearningSteps', 'Relearning steps (minutes)', settings.relearningSteps.map(value => `${value}m`).join(' '), 'text', parseSteps),
        row('dayStart', 'Day starts at (hour)', settings.dayStart, 'number', Number, { min: 0, max: 23, step: 1 }),
      ];
    };
    observe((state, loadError) => {
      if (signal.aborted) return; if (loadError) { showError(loadError); return; }
      if (!rows) rows = widget(ctx.ui.mountSettingsRows(fields, { rows: settingsRows(state.settings) }, { signal }), signal);
      else rows.update({ rows: settingsRows(state.settings) });
    }, signal);
    return () => { scope.abort(); root.remove(); };
  }
  registrations.push(ctx.registerView({ id: 'library', name: 'Flashcards', mount: mountLibrary }));
  registrations.push(ctx.registerSettings(mountSettings));
  registrations.push(ctx.onNotification(event => { if ((!event.pluginId || event.pluginId === ctx.manifest.id) && event.topic === 'changed') void refresh(); }));
  registrations.push(ctx.onResync(() => { void refresh(); }));
  const dispose = () => { for (const unregister of registrations.splice(0).reverse()) unregister(); observers.clear(); };
  ctx.cleanup(dispose); return dispose;
}
