# Reproducible baseline evaluation

Run commands **on the laptop** for development, or **on the Arduino** for hardware measurements. Python 3.10+ and the standard library are sufficient. The harness imports the selected source tree's existing `solve()`; it does not change production files, prompts, weights, retrieval, request parameters, or returned answers.

The original inference implementation is commit `366cf167982ab401b10b2a0ec5c71d622dea6074`. The checkout at the start of this audit was `89426b4d5c425f94fcb69a09df283356336fd809`, which already includes the no-options shortcut and opt-in calibration. Turning calibration off does **not** restore the original baseline.

## Freeze once

Use a new directory for a new dataset or protocol version. Existing manifests and runs are never silently overwritten. Keep all generated files under ignored `results/`.

```bash
python3 -m benchmark snapshot --output results/baseline-v1/source
python3 -m benchmark audit --output results/baseline-v1/dataset-audit.json
python3 -m benchmark prepare --output results/baseline-v1/manifests --dev-size 50
```

`dev.json` uses seed 42 and the same initial ordering as `eval.py --limit 50`. Additional translations of selected development IDs stay in development. `final.json` contains the remaining IDs in the same shuffled order. `full.json` contains everything. Manifests record ordered `(id, language)` keys, dataset-byte SHA256 and inference-input SHA256; changed bytes require an explicit new manifest version. This prevents silent changes to cohorts, labels or OCR between comparisons.

**The current 281 validation problems were already evaluated and used for earlier tuning.** Naming the remaining 231 cases `final` separates workloads, but does not make them an untouched holdout. Use a newly withheld dataset for a fresh generalization claim. Repeated or translated questions must be grouped before constructing that holdout, including repeats with different IDs. The audit detects canonical-ID overlap, normalized matching statements and same-language near matches; it cannot certify that every semantic duplicate was found.

## Reproduce the official evaluation first

Use an absolute dataset path below; run from the exported source directory.

```bash
cd results/baseline-v1/source
python3 eval.py --input /absolute/path/to/data/val.jsonl --limit 50 --name original-dev
python3 eval.py --input /absolute/path/to/data/val.jsonl --limit 0 --name original-full
python3 predict.py --input /absolute/path/to/data/sample_problems.jsonl --output results/smoke.csv
```

The old `eval.py` records the enclosing repository's HEAD when executed in a nested snapshot. Its commit column is therefore insufficient provenance. `baseline-source.json` and the instrumented runner's file hashes identify the actual source. Do not edit the old log to conceal this limitation.

## Capture all measurements

From the repository root, on the laptop:

```bash
python3 -m benchmark run --source results/baseline-v1/source \
  --manifest results/baseline-v1/manifests/dev.json \
  --output results/baseline-v1/original-dev --name original-dev --hardware laptop
python3 -m benchmark report --run results/baseline-v1/original-dev \
  --output results/baseline-v1/original-dev-summary.json
```

On the Arduino, use the same source, dataset and manifests, and `--hardware arduino`. The harness rejects that label on non-ARM hosts. `run.json` captures platform, device model when exposed, memory snapshot, running local server arguments, executable/model hashes when readable, server properties, source commit and hashes, config/environment overrides, manifest, cache note, timestamps, completion state and tooling hashes. A hardware label is not an independent board certification. Peak RAM, thermal throttling, cold startup and board deadline compliance still require board measurements; the memory snapshot is not a peak-RSS measurement.

The requests are sequential. The harness does not warm up, reset, restart, or share the model service deliberately. Stop unrelated requests during a timing run and record service cache/temperature conditions using `--cache-note`. Identical answer ordering does not imply equal warm-cache latency. Model weights and server settings must match across experiments; request temperature/seed alone do not prove deterministic behavior on every backend. The current audit compares an independent full rerun to the unchanged official run.

Each `predictions.jsonl` row contains:

- ID, language, school-level difficulty proxy, topic and topic provenance, truth, prediction and correctness.
- Five-option completeness, missing/duplicated options, named OCR suspicion flags, and suspected image dependency.
- Solver status, explicit fallback observation, uncaught-exception type, validity and deadline violation.
- High-resolution wall time, original rounded solver time, full prompt tokens, newly processed prompt tokens, cached tokens and generated tokens when supplied by the server. Missing counters are `null`, not invented zeroes.
- Every observed model/embedding call's parameters, request hash, timeout requested, usage/timings, response text and finish reason; source commit/digest, input hash and manifest hash.

`prompt_tokens_processed` is `timings.prompt_n`; it is **not** total prompt length. `prompt_tokens` is `usage.prompt_tokens`. `generated_tokens` comes from `usage.completion_tokens` or `timings.predicted_n`. The runner records source response fields without adding logprob requests. Future variants using another transport must expose that transport explicitly; absent observations are not evidence of zero model cost.

The scoring process strips input to **`id`, `text`, `options`, `language`** before calling `solve()`. Labels and evaluation annotations stay outside inference. Invalid outputs and uncaught exceptions remain recorded as failures; the harness does not silently turn them into letters. Original handled errors remain original fallbacks. It observes deadline overruns without changing baseline timeout behavior. If an experiment hangs, interrupt it; its run remains incomplete and the reporting/comparison commands reject it. Do not describe a partial run as full accuracy.

## RAG safeguards

```bash
python3 -m benchmark check-index --index data/index.db
# Add --rag 1 --index data/index.db to benchmark run only after this passes.
```

Each indexed JSON record must exactly match a training record, including its label, and must not share a validation ID (including translations), normalized statement, or same-language near-statement match at similarity 0.92. This deliberately rejects ambiguous common statements and potential false-positive near matches. The audit runs once before inference. Review candidates from `audit` too: different IDs and different letters can encode the same mathematics with reordered options. A passing automatic guard is not a semantic deduplication proof. The current dataset has confirmed cross-ID repeats, so an index built blindly from all of `train.jsonl` is unsuitable for an uncontaminated RAG comparison. Record any filtered training-file hash; never change validation labels or put them into a prompt or index. Do not use validation IDs to recover their answers from another source.

## Review and report

```bash
python3 -m benchmark inspect --run results/baseline-v1/original-dev \
  --output results/baseline-v1/private-inspection --limit 30
python3 -m benchmark report --run results/baseline-v1/original-dev \
  --reviews results/baseline-v1/reviews.jsonl --output results/baseline-v1/reviewed-summary.json
```

The private HTML/JSON packet contains restricted problem contents and stays under `results/`. Merely generating it is not inspection. After actually examining text, choices and, where necessary, source images, write JSONL annotations with `id`, `language`, `category`, `confidence`, `evidence`, `reviewer`, and sampling method. The CSV template is a convenience for editing; convert it to JSONL before `--reviews`.

Use `input_image_required`, `input_options_unavailable`, `input_ocr_confirmed`, `arithmetic_or_mapping_unresolved`, or `math_or_mapping_unresolved` where supported. Reserve a precise arithmetic/reasoning mechanism for evidence beyond a wrong letter. Figure-present metadata does not prove a figure is necessary, and duplicated choices can originate in the source image. Topic rules are a low-confidence English keyword taxonomy; `level` is a school-grade proxy, not measured item difficulty. Unknowns remain explicit. Review categories describe the inspected sample; do not extrapolate their proportions from a purposive sample. Aggregate quality flags can overlap.

The report includes overall and grouped accuracy, mean/median/nearest-rank-p95/max latency, A–E confusion matrix, predicted/true letter counts, status/fallback counts, token counts and error-observation counts. Invalid outputs remain in the accuracy denominator and have a separate count outside the A–E matrix.

## Compare variants on identical cases

```bash
python3 -m benchmark run --source . --manifest results/baseline-v1/manifests/dev.json \
  --output results/baseline-v1/variant-dev --name variant-dev --hardware laptop
python3 -m benchmark compare --left results/baseline-v1/original-dev \
  --right results/baseline-v1/variant-dev --output results/baseline-v1/paired.json
```

Use `final.json` only after selecting a variant; use `full.json` for a descriptive final full-validation run. Record all variants, including regressions, in separate output directories. `experiments.jsonl` is appended automatically. Comparison reports absolute accuracy difference in percentage points, fixed/regressed IDs, all changed letters, paired latency deltas, both latency distributions, a seeded paired bootstrap clustered by problem ID, and exact McNemar p when every ID occurs once. Repeated validation selection and cross-ID repeats limit statistical interpretation. Compare hardware/cache/server provenance before interpreting latency. Legacy `eval.py` CSVs are accepted, with missing provenance explicitly unknown; exact ID/language order and labels must still agree.

## Verify the infrastructure

```bash
python3 -m unittest benchmark.test_benchmark -v
```

Tests use synthetic data only and check input-label isolation, translation grouping, frozen cohorts, leakage rejection, observation transparency, conservative quality flags, paired statistics and mismatched-run rejection. Restricted JSONL, images, indexes, private review packets and experiment outputs are already excluded by the repository's `data/` and `results/` rules. No dataset files need to be committed to reproduce the commands after authorized local preparation.
