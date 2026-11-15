# Cortex: a Kangaroo maths copilot for the Arduino UNO Q

Datathon FME 2026 (UPC), Qualcomm challenge: *Math on the Edge*. The copilot runs offline and uses the M3Kang dataset of Kangaroo problems. It has two parts, graded half each:

- **Reason** (`predict.py`): picks the answer A–E of a Kangaroo-style problem on the board, under 60 s per problem.
- **Teach** (`copilot/teach/` and `cortex/`): adaptive practice that makes the student commit to an answer first, plus flashcards with spaced repetition. No language model is used.

The official challenge text is in [docs/challenge-kit.md](docs/challenge-kit.md).

## Reason

`predict.py` asks the small model (Qwen3.5 0.8B on `llama-server`) for a short brute-force Python program, **without showing it the options**. It runs that program in a sandbox (a few standard modules, CPU, memory and time limits) and answers the option that matches the output, or the nearest number. If nothing comes out, it answers `D` immediately. The time budget is 55 s per problem. Details, discarded ideas and the steps for the board: [REASON.md](REASON.md).

Results **on the laptop**, on the organisers' practice set (50 problems in English and Catalan, 100 rows):

| Version | Text only (80) | With figure (20) | Total |
|---|---|---|---|
| Previous pipeline | 16 | 7 | 23 |
| Program + check, Qwen3.5 0.8B | 22 | 9 | 31 |
| Program + check, Qwen2.5-Coder 1.5B (Q4_K_M) | 37 | 10 | 47 |

Figures are not solved: there the answer is always `D`, which happens to be right in 5 of the 10 figure problems. Timings and accuracy on the UNO Q itself are still to be measured; see REASON.md.

## Teach

### Adaptive trainer (`copilot/teach/trainer.py`)

Standard library only, so it runs on the board.

- A right answer brings the most similar unseen problem one level up; a wrong one, a problem one level down on the same topic when known.
- It never repeats a problem: the same id in another language, and the same problem reused in another level of the same year, count as seen.
- The student's level is a Bayesian estimate on a grid of levels 0–7, with a logistic model of P(right) that allows for guessing among five options.
- The profile and every answer are stored in SQLite.

With simulated students on the M3Kang English bank (logistic students, 8 true levels × 20 seeds), the mean absolute error of the estimated level is **0.65 levels after 10 problems and 0.49 after 20**. For comparison, a staircase gives 0.84 and a fixed guess gives 2.00. No problem was ever repeated. Run it with `python3 -m copilot.teach.trainer`.

### Cortex web app (`cortex/`)

A local web app built on the trainer (a cut-down [LearnHarness](https://github.com/amosblomqvist/learnharness), AGPL-3.0):

- **Practice.** The app opens straight on a problem, showing the statement with formulas (KaTeX) and its figure. The student picks one letter and sets a confidence (0–100 %) before submitting. Grading happens on the server and the right letter never reaches the browser before the answer is submitted. The next problem adapts.
- **Explain after answering.** After the answer, an **Explain** button reveals a short hand-written solution. It is static text: no model, no cost, instant.
- **Flashcards.** Anki-style decks with today's New / Learn / Due counts, FSRS-6 scheduling and charts of cards due and cards reviewed. The **Kangaroo toolkit** deck has 20 cards of formulas and techniques: areas, Pythagoras, polygon angles, divisibility, counting, pigeonhole, probability and percentages.
- **Offline.** In a browser check with Internet blocked, no request left the machine.

How to run it, configuration and what was removed from LearnHarness: [cortex/README.md](cortex/README.md) and [cortex/DEMO_SCOPE.md](cortex/DEMO_SCOPE.md). The web app has been checked on the laptop, not yet on the board.

## Data

M3Kang is licensed for research use only. Nothing under `data/` is committed except `data/sample_problems.jsonl` (made-up problems for smoke tests), and neither are images or `.env` files. To prepare the problems:

```bash
.venv/bin/python laptop/prepare_m3kang.py --save-images                 # M3Kang → data/train.jsonl, data/val.jsonl
.venv/bin/python laptop/prepare_m3kang.py --parquet <practice.parquet> \
    --out data/demo --save-images --val-fraction 0                     # organisers' practice set → data/demo/
```

Cortex's explanations for the practice set live in `cortex/data/explanations.json`, outside Git for the same reason.

## Repository

| Path | What |
|---|---|
| `predict.py`, `eval.py`, `copilot/` | Reason pipeline, evaluation and the shared client code |
| `copilot/teach/trainer.py` | Adaptive trainer (Teach) |
| `cortex/` | Teach web app: practice, explanations, flashcards |
| `board/`, `config.env` | Board setup: pinned llama.cpp and models |
| `laptop/` | Data preparation (OCR of the options) |
| `experiments/`, `tests/` | Experiments behind REASON.md and unit tests |
| `docs/` | Official kit README and the team's challenge brief |
