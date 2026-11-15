// Anki-style deck overview: one row per deck with what is ready to study
// today (new, learning, due), a click to study, and quick add/settings.
const plusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const settingsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>';
const COLUMNS = [['new', 'New'], ['learn', 'Learn'], ['review', 'Due']];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountDeckList({ container, signal, button, onStudy, onAddCard, onSettings, onCreateDeck }) {
  const root = el('section', 'fc-decks'); root.setAttribute('aria-labelledby', 'fc-decks-heading');
  const header = el('div', 'fc-decks-header');
  const heading = el('h2', 'fc-decks-heading', 'Decks'); heading.id = 'fc-decks-heading';
  header.append(heading);
  button(header, 'Create deck', onCreateDeck, signal);
  const table = el('div', 'fc-decks-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Decks');
  const head = el('div', 'fc-decks-row fc-decks-head'); head.setAttribute('role', 'row');
  head.append(el('span', 'fc-decks-name', 'Deck'), ...COLUMNS.map(([key, label]) => { const c = el('span', `fc-decks-count`, label); c.dataset.count = key; return c; }), el('span', 'fc-decks-actions'));
  for (const cell of head.children) cell.setAttribute('role', 'columnheader');
  const body = el('div', 'fc-decks-body');
  const empty = el('p', 'fc-muted fc-decks-empty', 'No decks yet. Create one, then add cards with +.');
  const today = el('p', 'fc-decks-today');
  table.append(head, body);
  root.append(header, table, empty, today);
  container.append(root);
  let rows = [];
  function update(state) {
    if (signal.aborted) return;
    for (const scope of rows) scope.abort();
    rows = []; body.replaceChildren();
    const decks = state?.decks ?? [];
    empty.hidden = decks.length > 0; table.hidden = decks.length === 0;
    const totals = { new: 0, learn: 0, review: 0 };
    for (const deck of decks) {
      const scope = new AbortController(); rows.push(scope);
      const rowSignal = AbortSignal.any([signal, scope.signal]);
      const counts = deck.counts ?? { new: 0, learn: 0, review: 0 };
      for (const key of Object.keys(totals)) totals[key] += counts[key] ?? 0;
      const row = el('div', 'fc-decks-row'); row.setAttribute('role', 'row'); row.dataset.deck = deck.id;
      const name = el('button', 'fc-decks-name fc-decks-study', deck.name); name.type = 'button';
      name.title = `Study ${deck.name}`; name.setAttribute('role', 'cell');
      name.addEventListener('click', () => onStudy(deck), { signal: rowSignal });
      row.append(name);
      for (const [key] of COLUMNS) {
        const value = counts[key] ?? 0;
        const cell = el('span', 'fc-decks-count', String(value)); cell.dataset.count = key; cell.setAttribute('role', 'cell');
        if (!value) cell.classList.add('fc-zero');
        row.append(cell);
      }
      const actions = el('span', 'fc-decks-actions'); actions.setAttribute('role', 'cell');
      button(actions, 'Add card', () => onAddCard(deck), rowSignal, { icon: plusIcon, iconOnly: true, size: 'icon-sm', variant: 'ghost', title: `Add a card to ${deck.name}` });
      button(actions, 'Deck options', () => onSettings(deck), rowSignal, { icon: settingsIcon, iconOnly: true, size: 'icon-sm', variant: 'ghost', title: `${deck.name} options` });
      row.append(actions); body.append(row);
    }
    const ready = totals.new + totals.learn + totals.review;
    today.textContent = decks.length ? (ready ? `Today: ${totals.new} new, ${totals.learn} learning, ${totals.review} due. Click a deck to study.` : 'Nothing to study right now. Come back later or add cards.') : '';
  }
  function dispose() { for (const scope of rows) scope.abort(); root.remove(); }
  signal.addEventListener('abort', dispose, { once: true });
  return { update, dispose };
}
