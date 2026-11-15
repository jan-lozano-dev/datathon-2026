# Flashcards

The built-in Flashcards plugin of the M3Kang practice build: flat decks, hand-written cards and spaced review with FSRS-6. Everything is local. It makes no model calls and has no Anki integration.

Generation from the knowledge graph and from uploaded documents was removed together with those sources. Cards that an earlier LearnHarness version generated stay in the store and can still be reviewed, edited and deleted.

## Use

Open **Flashcards** in the top navigation. The gear next to the title opens the settings.

### Write cards by hand

The **+** immediately left of a deck's gear opens **Create card**. Enter a Name, then a Question and an Answer in Markdown. Saving creates a new target and its first cue together in that deck. The **+** on a target row opens **Add cue**, with only Question and Answer. The new cue shares that target's schedule and memberships. All fields must be filled in, and Cancel creates nothing. Retrying after a lost response never creates duplicates.

### Decks and review

The library opens on an Anki-style deck list. Each deck shows what is ready today: **New** (still within the deck's daily limit), **Learn** (learning steps due now) and **Due** (reviews due). Click a deck to study it, use **+** to add a card and the gear for deck options (rename, daily new limit, delete). **Create deck** sits next to the list.

Below it, **Progress** shows two charts: cards due over the next days and cards reviewed over the last two weeks.

**Browse cards** (folded) holds the full Deck → Target → Cue tree, with search, selection, Review/Practice selected, editing, memberships, ordering and deletion. Click a cue for a preview.

Review shows the question, then the answer on reveal (Space), then a self-rating: Again, Hard, Good or Easy (keys 1 to 4). Close with the X or Escape. Learning and relearning cards come first, then due reviews, then new targets, up to 20 new targets per deck per day by default. Due reviews are not capped.

### Delete content

Selecting anything shows a trash button next to Review/Practice. Deletion asks for one confirmation, with **Delete empty decks too** checked by default. Deleted cues are removed everywhere they are shared. Past ratings stay available for statistics, without the question or answer text.

### Extra practice

**Practice** (in Browse cards) runs once through a snapshot of cues with reveal and Next, and changes no schedule.

### Settings

Desired retention (default 90%), learning steps (1m 10m), relearning steps (10m) and the hour the study day starts (04:00). FSRS-6 uses published parameters with deterministic intervals, no fuzz and no optimizer. The schedule belongs to the target, not to each card.

Questions and answers use the app's Markdown rendering, including math, code, tables and Mermaid.

## Data

The plugin's state is `<data>/core-plugin-data/flashcards/flashcards.json`, a versioned JSON snapshot replaced atomically after each change. One server process owns writes. A corrupt or unsupported store is reported as an error and never reset silently.

## Build and tests

The app builds this package with `npm run plugins:build-core`; `npm run plugins:setup` installs its `esbuild` dependency first. From the app root:

```sh
npm run test:flashcards
```

The tests cover storage and migrations, deletion and retry receipts, manual creation, cue-filtered review, memberships, scheduling and statistics, the dashboard, practice, tree selection and frontend lifetimes. The DOM tests use `linkedom` from the app checkout.

## Source

- [`src/main.js`](src/main.js): the view, settings and calls to the backend.
- [`src/library-tree.js`](src/library-tree.js), [`src/review.js`](src/review.js), [`src/practice-queue.js`](src/practice-queue.js) and [`src/dashboard.js`](src/dashboard.js): the tree, review surfaces, practice and statistics UI.
- [`src/backend.cjs`](src/backend.cjs): the operations on decks, cards and reviews.
- [`src/store.cjs`](src/store.cjs), [`src/scheduler.cjs`](src/scheduler.cjs) and [`src/statistics.cjs`](src/statistics.cjs): storage, FSRS-6 and statistics.

## License

AGPL-3.0-only, matching LearnHarness. The dependency-free FSRS subset is selectively adapted from MIT-licensed `ts-fsrs@5.2.3`; see `FSRS-LICENSE.txt`.
