# Math on the Edge: an offline Kangaroo maths copilot on an Arduino UNO Q

Datathon FME 2026 (UPC), Qualcomm main challenge. The copilot runs entirely on an Arduino UNO Q (4 GB, no network) and works on [M3Kang](https://arxiv.org/abs/2601.16218), a dataset of Kangaroo maths-competition problems. It has two parts, graded half each:

- **Reason** (`predict.py`): picks the answer A–E of a Kangaroo problem, under 60 s per problem.
- **Teach** (`cortex/`): adaptive practice that makes the student commit to an answer first, with explanations and spaced-repetition flashcards. It uses no language model.

## Reason

A small model is bad at picking a letter directly (the original baseline scored 65/281, the same as always answering `D`). So `predict.py` asks **Qwen2.5-Coder 1.5B Q4_K_M** for a short brute-force Python program, **without showing it the options**. It runs the program in a sandbox (a few standard modules, CPU, memory and time limits) and answers the option that matches the output, or the nearest number. If nothing comes out, it answers `D` straight away. The budget is 55 s per problem.

### Results

| Measure | Result |
|---|---|
| Organisers' practice set (100 rows), laptop, baseline | 23/100 |
| Same set, Qwen2.5-Coder 1.5B (variant E10, full run) | **46/100**: 40/80 on text-only, 6/20 with a figure |
| Own synthetic problems (80 rows), laptop, baseline → Coder 1.5B (E11) | 19/80 → 54/80 |
| UNO Q, practice subset (40 rows) | 19/40 (47.5 %), 29.8 s mean, 48.0 s worst |

Read these with care:

- The practice set is 50 problems, each in English and Catalan. They are not 100 independent observations, and the hidden test is expected to be small (about ±10 points of noise).
- The synthetic set was used to choose variants, so it is not an independent test.
- The board figure is an **aggregate record only**: there is no per-question CSV and RAM use was not measured.
- Figures are not solved: with a figure the answer comes from the fallback path.

Full tables by language, level, topic and path, and what is still missing: [docs/results.md](docs/results.md). The method, discarded ideas and the steps to repeat a measurement: [docs/reason.md](docs/reason.md).

## Teach

[`cortex/`](cortex/) is a local web app (a cut-down [LearnHarness](https://github.com/amosblomqvist/learnharness), AGPL-3.0):

- **Practice.** It opens on a problem with its statement and figure. The student picks a letter and a confidence (0–100 %) before submitting. Grading is on the server, so the right letter never reaches the browser early. The next problem adapts.
- **Explain after answering.** A short hand-written solution, static text: no model, no cost.
- **Flashcards.** Anki-style decks with FSRS-6 scheduling. The *Kangaroo toolkit* deck has 20 cards of formulas and techniques.
- **Offline.** With the network blocked, no request left the machine.

It has been checked on a laptop, not yet on the board. How to run it and what was removed from LearnHarness: [cortex/README.md](cortex/README.md) and [cortex/DEMO_SCOPE.md](cortex/DEMO_SCOPE.md).

## Quick start

On a laptop, with Python 3.10+:

```bash
python3 -m venv .venv && .venv/bin/pip install -r laptop/requirements.txt
.venv/bin/python laptop/prepare_m3kang.py --save-images        # M3Kang → data/train.jsonl, data/val.jsonl
python3 predict.py --input data/sample_problems.jsonl --output results/check.csv
python3 eval.py --limit 200 --name my-change                   # needs llama-server on port 8081
```

On the board, after preparing the UNO Q and building llama.cpp, run `board/03_download_models.sh`, `board/04_install_services.sh` and `board/05_smoke_test.sh`. They read [`config.env`](config.env), which pins llama.cpp, Qwen2.5-Coder 1.5B Q4_K_M and the embedding model by commit and SHA256. The code that runs on the board uses only the Python standard library.

## Data

M3Kang is licensed for research use only. Nothing under `data/` is committed except `data/sample_problems.jsonl` (made-up problems for smoke tests). Images, `.env` files and the private `results/` stay out of Git. See [data/README.md](data/README.md).

## Repository

| Path | What |
|---|---|
| `predict.py`, `eval.py`, `copilot/` | Reason pipeline, evaluation and shared client code |
| `cortex/` | Teach web app |
| `board/`, `config.env` | Board setup: pinned llama.cpp and models |
| `laptop/`, `explorer/` | Data preparation (OCR of the options) and a problem explorer |
| `benchmark/`, `experiments/`, `tests/` | Reproducible evaluation harness, experiments and unit tests |
| `docs/` | Reports, plans and the challenge text ([index](docs/README.md)) |
| `agents/` | Instructions, skills and prompts for AI agents ([index](agents/README.md)) |

## License

MIT, see [LICENSE](LICENSE). The exception is [`cortex/`](cortex/), which derives from LearnHarness and is licensed under AGPL-3.0 (see [cortex/LICENSE](cortex/LICENSE)). M3Kang is not covered: it is licensed for research use only.

## Credits

Built on the organisers' kit ([mpous/datathon-UPC-maths-qualcomm-arduino-unoq](https://github.com/mpous/datathon-UPC-maths-qualcomm-arduino-unoq)) and on the [M3Kang](https://arxiv.org/abs/2601.16218) dataset. The Teach app derives from [LearnHarness](https://github.com/amosblomqvist/learnharness) (AGPL-3.0). The Tinybird side challenge lives in its own repository.
