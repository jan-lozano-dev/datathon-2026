# Cortex: Kangaroo maths practice (LearnHarness, M3Kang build)

An offline web app for practising Kangaroo maths problems from the M3Kang dataset. It is a cut-down LearnHarness: the student answers one letter A–E, says how sure they are, and an adaptive trainer picks the next problem. After answering, a short explanation is one click away, and flashcards with spaced review stay available. No step calls a language model, and the running app makes no requests outside the machine.

What was kept, what was removed and why, and how it was checked: [DEMO_SCOPE.md](DEMO_SCOPE.md).

## How it works

- **Practice** (`/`): opens straight on a problem and resumes where it was left; there is one local profile and no sign-in, and the problems are in English. Each problem shows its statement with formulas (KaTeX) and its figure. Grading and the choice of the next problem happen on the server: a right answer brings a harder problem, a wrong one an easier one, and no problem is repeated.
- **Trainer**: the team's `copilot/teach/trainer.py`, used unchanged through [`practice/bridge.py`](practice/bridge.py) (Python standard library only). The bridge adds the session, the confidence stored with each attempt, idempotent submissions and skipping a problem whose required figure is missing.
- **Explanations**: after answering, an **Explain** button shows a short hand-written solution (Markdown with KaTeX), read from a local file. Nothing is generated.
- **Flashcards** (`/plugins/flashcards/library`): decks, hand-written cards in Markdown and FSRS-6 review. See [plugins/flashcards/README.md](plugins/flashcards/README.md). The **Kangaroo toolkit** deck ([practice/decks/kangaroo-toolkit.json](practice/decks/kangaroo-toolkit.json)) has 20 cards of formulas and facts: areas, Pythagoras, angles, divisibility, counting, probability.

## Requirements

- Node.js 24 and npm. The first `npm ci` and `npm run build` need network access (packages and the two Google fonts that `next/font` bundles at build time). Running the app does not.
- Python 3.10 or newer as `python3`.
- The trainer: `copilot/teach/trainer.py` from the team repository. Inside the team repository (this app in `cortex/`) it is found automatically at `../copilot/teach/trainer.py`.
- The M3Kang problems: JSONL files in the `prepare_m3kang.py` format and, for figures, `images/<id>_<language>.png`. M3Kang is licensed for research use only: keep it out of Git (`data/` is ignored).

## Run it

```bash
npm ci
npm run plugins:setup                     # installs the Flashcards build dependency

# Link the problem bank (here: the practice set with its images, prepared by
# laptop/prepare_m3kang.py into the team repository's data/demo; not in Git)
mkdir -p data
ln -s ../../data/demo data/m3kang         # from cortex/ inside the team repository

# Development
npm run dev                               # http://localhost:3000

# Or production
npm run build
npm start                                 # http://localhost:3000

# With the server running, load the Kangaroo toolkit deck (safe to repeat)
npm run seed:flashcards
```

Explanations are read from `data/explanations.json`: a JSON object from problem id to Markdown text, or to `{"eng": "...", "cat": "..."}` per language. They are only sent after the student answers. Keep the file out of Git when it describes restricted problems.

Every `*.jsonl` file in `data/m3kang/` is loaded into the bank. To point elsewhere without a link:

```bash
LH_M3KANG_DIR=/path/to/bank LH_TRAINER_PY=/path/to/trainer.py npm start
```

| Variable | Default | Purpose |
|---|---|---|
| `LH_DATA_DIR` | `./data` | Mutable data: `practice.db`, `core-plugin-data/flashcards/`, `m3kang/` |
| `LH_M3KANG_DIR` | `<data>/m3kang` | Problem JSONL files and `images/` |
| `LH_TRAINER_PY` | `../copilot/teach/trainer.py`, else `../../wt-teach/copilot/teach/trainer.py` | The adaptive trainer |
| `LH_PYTHON` | `python3` | Interpreter for the bridge |
| `LH_EXPLANATIONS` | `<data>/explanations.json` | Hand-written explanations per problem id (optional) |
| `LH_ALLOWED_HOSTS` | (empty) | Extra host names besides localhost and IP addresses |

The server listens on localhost by default. To use it from another device on the network, start it with `-H 0.0.0.0` (`npx next start -H 0.0.0.0`). There is no authentication: anyone who can reach the server shares the one local profile.

## Checks

```bash
npm run typecheck
npm run lint
npm test                    # app tests
npm run test:practice       # bridge tests on a synthetic bank (skip without the trainer)
npm run test:flashcards
```

Browser checks (a running server, a Chromium browser, no Internet needed):

```bash
LH_BROWSER=/path/to/chrome LH_BASE_URL=http://localhost:3000 node scripts/browser-checks/practice.mjs
```

## Data

- `<data>/practice.db`: SQLite with the trainer's `students` and `attempts` tables, plus `lh_attempts` (confidence and submission id per attempt), `lh_sessions` (language and the problem shown) and `lh_skips`.
- `<data>/core-plugin-data/flashcards/flashcards.json`: decks, cards and review history.

Both stay on this machine. Deleting them resets the progress.

## License

[AGPL-3.0](LICENSE), as LearnHarness.
