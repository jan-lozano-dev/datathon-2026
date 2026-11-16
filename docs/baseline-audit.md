# Original baseline audit — 14 November 2026

The original baseline scored **65/281 (23.13%)** in an executed full-validation run, exactly equal to always answering D on these cases. An independent instrumented rerun produced **the same 281 answer letters**. The fixed 50-case development run scored 16/50 (32.00%); always-D scored 17/50. All inference measurements in this report are from the **WSL x86_64 laptop**, not an Arduino. Board accuracy, latency and 4 GB memory compliance remain unmeasured.

The demonstrated problems are missing input information, damaged answer options, extremely uneven letter selection, and wrong answers even on apparently complete text inputs. The one-letter response does not expose enough evidence to separate arithmetic mistakes from reasoning, reading or answer-mapping mistakes. No new optimization was implemented.

## What was actually evaluated

| Item | Recorded value |
| --- | --- |
| Starting checkout | `89426b4d5c425f94fcb69a09df283356336fd809` |
| Original inference source | `366cf167982ab401b10b2a0ec5c71d622dea6074`, exported without edits |
| Original source digest | `9c1f313e35d7034c0c1c5f996bb72dfd41e3679861f867757f404abe58b588b9` |
| Model | Qwen3.5 0.8B, Q8_0 |
| Verified weight SHA256 | `7182e2362766bb9569209bbc24cf1a4cdfbb8ab161babdb2080c84fa62c08c2f` |
| Actual llama.cpp version | `0.9.0-dev`, commit `2cbe0ec`, Linux x86_64 build |
| Server | Four threads, context 4096, one slot, cache RAM 0, two context checkpoints, reasoning off, reasoning budget 0 |
| Request | Temperature 0, seed 42, grammar `root ::= [A-E]`, max tokens 1, prompt cache enabled |
| Retrieval | Off (`k=0`) |
| Validation SHA256 | `5973ecef982b90baf5a0c95378d0ae7d7c5c137e16a3d2d59ffbc1c18f53baf0` |
| Training SHA256 | `ef950fb3764e58f71df7ff4acab82938799828388922eb8ee461099284a89d61` |
| Full manifest digest | `d01a6179f155d95954d719b6da2aa86739e67917e35da9e79360630ff8bc801f` |

The current checkout already contains a no-options shortcut and opt-in letter calibration. Disabling calibration alone would not reproduce the original solver. The original snapshot was therefore run separately, leaving `predict.py`, `eval.py`, `copilot/`, `build_index.py`, preparation code, model weights, prompts and RAG logic untouched.

Executed artifacts, all local and ignored by Git:

| Artifact | Location under `results/baseline-audit/` |
| --- | --- |
| Original 50-case evaluation | `original-eval-50.log`; `original-source/results/eval-20261114-232607-original-50.csv` |
| Original full evaluation | `original-eval-full.log`; `original-source/results/eval-20261114-232658-original-full.csv` |
| Independent full rerun with per-case telemetry | `original-full-instrumented/run.json`, `original-full-instrumented/predictions.jsonl` |
| Aggregates | `original-50-summary.json`, `original-full-summary.json`, `instrumented-summary.json` and adjacent Markdown files |
| Answer parity | `instrumentation-parity.json` — zero changed answers; zero fixed cases/regressions |
| Dataset audit and frozen cohorts | `dataset-audit.json`, `manifests/{dev,final,full}.json` |
| Inspections | `reviews.jsonl`; private extracted source images in `inspection-images/` |
| Model/environment verification | `initial-environment.json`; detailed environment in the rerun's `run.json` |
| Existing-variant paired comparison | `comparison-existing-current.json` |

The old `eval.py` derives its commit from the enclosing Git checkout, so its nested-snapshot CSV log names the current HEAD. That is a known provenance limitation, not the code version used. The exported `baseline-source.json`, individual file hashes and rerun metadata identify the actual original code. Earlier existing logs also record the same commit for different working-tree variants; future runs must record hashes and dirty state as well as Git HEAD.

No Arduino connection was discovered: no `adb` executable was found and no board SSH target was configured or supplied. The local model on 8081 was healthy; 8082 had no embedding service, no index existed and the embedding model file was absent. Original RAG and all board experiments remain unexecuted. No server was restarted or model setting changed.

## Original inference and retrieval pipelines

`predict.py` reads JSONL, calls `solve()` sequentially and writes `id,language,answer,seconds,status`. The original solver formats the statement and available A–E choices, prepends a stable system instruction and requests one constrained token. Without choices it explicitly tells the model that the options are in an unseen picture and asks it to choose a likely letter. It still makes the model call; skipping that call belongs to the later checkout.

Optional RAG embeds `format_problem()` using bge-small-en-v1.5. Queries receive the configured English prefix; documents do not. Embedding input is truncated to 1,400 characters. `build_index.py` stores the full training JSON and float32 vectors in SQLite. `Index` loads them into memory, computes dot products, sorts, and returns the top K. Retrieved examples contribute question/options and their training answer letter, with no worked reasoning. `eval.py` excludes the current ID across languages; `predict.py` does not pass `exclude_id`, so training-index purity is essential. `build_index.py --input` accepts arbitrary files and has no split-membership guard.

The nominal deadline is 60 seconds with a three-second margin. Socket/URL timeouts return D; other handled URL errors also return D. The implementation does not validate a returned letter beyond trusting the server grammar. Malformed response JSON/fields can raise uncaught exceptions. Retrieval embeddings have their own default 60-second timeout and are not bounded by the solver's remaining deadline; afterward it still allows at least one second for the LLM. Thus the code alone does **not** prove a hard end-to-end 60-second bound in RAG or malformed-server conditions. None of those failures occurred in the executed no-RAG runs.

## Dataset and input audit

The upstream `standard` and `high_quality` partitions describe data quality, not this repository's training/validation split. The local cached shard is `high_quality-00000-of-00004.parquet`, revision `e772e611d45679cf48f1c92618b2963a40d1d584`. Local JSONL contains **1,747 English rows**: 1,466 train and 281 validation, one language/ID pair per row. There is no local Catalan or other-language evaluation data. Upstream defines a shared ID for a problem and its translations, a school level, a figure-presence flag, text, image and label. [Dataset card](https://huggingface.co/datasets/qualcomm/M3Kang).

Preparation assigns validation when `int(sha256(id), 16) % 1000 < 150`, unless whole validation years are requested. Every local row agrees with the default hash split; the realized validation proportion is 16.09%. Canonical IDs therefore keep translations together. The local audit found zero shared train/validation IDs, zero duplicate `(id, language)` keys and zero invalid A–E labels. Because the local corpus is English-only, it cannot measure multilingual translation coverage or noncanonical translated duplicates.

| Input property | Train / 1,466 | Validation / 281 | Interpretation |
| --- | ---: | ---: | --- |
| Five nonempty A–E options | 911 (62.14%) | 167 (59.43%) | Syntactic completeness, not proof of correct OCR |
| Missing options | 555 (37.86%) | 114 (40.57%) | All are empty dictionaries in these files; no partial-option rows |
| Duplicated normalized option values | 5 (0.34%) | 1 (0.36%) | Validation duplicate is also present in its source image |
| Suspected OCR/layout corruption | 96 (6.55%) | 21 (7.47%) | Heuristic flags, not measured OCR error rate |
| `text_only=false` | 778 (53.07%) | 158 (56.23%) | Figure present; necessity requires inspection |

The 21 validation suspicion flags comprise 17 numeric-spacing cases, three mathematical-layout cases and one duplicate-choice case. Examples of flags are separated numeric fragments and duplicated superscript-like tokens. Fractions and legitimate formatting can trigger them; dropped digits and fraction bars can evade them. Four inspected validation images directly demonstrate OCR differences: `lvl-0_2017_2`, `lvl-4_2017_26`, `lvl-6_2018_4`, and `lvl-0_2017_7`. These are examples, not a random sample or an exhaustive count. In `lvl-6_2015_17`, two options are identical in the original image itself, so blaming OCR would be incorrect.

Missing options and image dependence overlap: 78 rows have both empty choices and figure-present metadata; another 36 text-only rows still lack choices. A mathematically solvable statement does not generally supply a mapping from its value to A–E. Conversely, figure metadata can overstate necessity: some counting/perimeter statements contain enough information without their illustration.

**Cross-ID content leakage exists.** There are five exact normalized-statement train/validation pairs involving four validation IDs, plus five near-match candidates with similarity at least 0.92. Twelve within-training statement groups also repeat. These are text-based counts, not claims of identical image bytes. Local source-image inspection confirmed repeated tasks, including changed option order:

| Validation ID | Training match | Inspection finding |
| --- | --- | --- |
| `lvl-0_2024_1` | `lvl-1_2024_1` and `lvl-5_2024_1` | Repeated shape-discrimination statement; inspected level-0/level-1 images reorder/rotate choices and have different correct letters. |
| `lvl-2_2024_19` | `lvl-3_2024_14` | Images confirm the same geometric task and dimensions. |
| `lvl-5_2018_16` | `lvl-4_2018_22` | Same box-net diagram; choices permuted and correct letter changes. |
| `lvl-6_2023_12` | `lvl-5_2023_21` | Same geometric task; both OCR outputs also mishandle fractional options. |

Near matches include a repeated height-equation task with renamed people, as well as geometry/logic candidates requiring further image review. The automatic check cannot certify all semantic duplicates or translations. The executed baseline used no retrieval, so these matches did not feed validation answers into its prompt. They **would undermine a naive training-index RAG or training-based optimization comparison**. Group repeated mathematics across IDs and languages before declaring a clean holdout; do not transfer a label from a matching statement because option order may differ.

The realistic hidden-inference contract comes from `predict.py`: **`id` and `text` are required; `options` and `language` are optional.** The repository does not establish that hidden inputs include `level`, `year`, `text_only`, `topic`, image bytes or a path to an image. `label` is evaluation-only. `predict.py` does not forward image bytes to `solve()`; the optional image pathway belongs to the explorer. The new harness sends only the four contract fields into inference and computes all quality/topic/scoring metadata separately. An optimization that requires unseen images or a same-ID translation lookup is conditional on additional organizer input guarantees.

## Accuracy, latency and tokens

| Executed run | Correct / n | Accuracy | Mean s | Median s | p95 s | Max s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original `eval.py`, fixed development set | 16 / 50 | 32.00% | 0.903 | 0.860 | 1.250 | 1.560 |
| Original `eval.py`, full validation | 65 / 281 | 23.13% | 1.117 | 1.110 | 1.630 | 1.920 |
| Independent instrumented original, full validation | 65 / 281 | 23.13% | 1.084 | 1.094 | 1.513 | 1.792 |

All rows in all three runs returned a valid A–E letter with status `ok`: no observed timeout, fallback, parsing failure or over-60-second case. The two original `eval.py` runs record seconds rounded to two decimals; the rerun uses an external high-resolution wall clock. p95 is nearest rank. Separate-run timing differences are normal service/cache/load variation, not an optimization result. Server startup and model load are excluded. The first 50 predictions also agree between the separate development and full runs. This demonstrates repeatability in the measured laptop configuration, not on every hardware backend.

The instrumented full run observed mean full prompt length **130.50 tokens** (median 129, p95 173, max 215), mean newly processed prompt length **97.50** (median 96, p95 140, max 182), **33 cached prompt tokens** on every row, and **one generated token** on every row. The original evaluator's `prompt_tokens` column actually contains `timings.prompt_n`, which counts newly processed tokens. The new tooling stores it separately from `usage.prompt_tokens`; these are distinct quantities in the [pinned llama.cpp server documentation](https://raw.githubusercontent.com/ggml-org/llama.cpp/2cbe0ec429b849a88664e0f62388fc92a5abd699/tools/server/README.md).

The README's 22.5% on 40 English text-only cases and 8.7-second board mean are historical reference measurements on a different subset, not results reproduced here. Laptop timing is not evidence of UNO Q deadline or RAM compliance.

All 281 rows are English: language accuracy is 65/281 = 23.13%; other languages are unmeasured. `level` is the available **school-level difficulty proxy**, not an independently measured difficulty grade.

| Level | Correct / n | Accuracy |
| --- | ---: | ---: |
| 0 | 6 / 20 | 30.00% |
| 1 | 7 / 17 | 41.18% |
| 2 | 11 / 29 | 37.93% |
| 3 | 1 / 12 | 8.33% |
| 4 | 15 / 62 | 24.19% |
| 5 | 10 / 53 | 18.87% |
| 6 | 6 / 49 | 12.24% |
| 7 | 9 / 39 | 23.08% |

There is no original topic field. The following uses the versioned English keyword rules in `benchmark/common.py`, tagged low confidence. Precedence resolves multiple keyword matches; 68 cases remain unknown. These small, noisy groups support triage, not claims of precise topic competence.

| Derived topic | Correct / n | Accuracy |
| --- | ---: | ---: |
| Algebra | 2 / 5 | 40.00% |
| Arithmetic | 8 / 46 | 17.39% |
| Combinatorics | 2 / 4 | 50.00% |
| Geometry | 23 / 112 | 20.54% |
| Logic | 0 / 12 | 0.00% |
| Number theory | 12 / 31 | 38.71% |
| Probability | 2 / 3 | 66.67% |
| Unknown | 16 / 68 | 23.53% |

| Input-quality group | Correct / n | Accuracy |
| --- | ---: | ---: |
| Five readable option strings | 38 / 167 | 22.75% |
| Empty options | 27 / 114 | 23.68% |
| Suspected OCR/layout corruption | 3 / 21 | 14.29% |
| No automatic corruption flag | 62 / 260 | 23.85% |
| Duplicated option values | 0 / 1 | 0.00% |
| Figure present / image dependency suspected | 36 / 158 | 22.78% |
| Text-only metadata | 29 / 123 | 23.58% |
| Five options + text-only + no corruption flag | 18 / 80 | 22.50% |

The similar raw accuracy with/without choices does not show that choices are useless. The cohorts differ in content and label distribution, and missing-choice successes can be guesses. No causal OCR-repair ablation was performed.

## Confusion matrix and letter selection

Rows are ground truth; columns are predictions. Invalid outputs would be counted separately; there were none.

| Truth | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 19 | 8 | 0 | 28 | 0 |
| B | 18 | 14 | 0 | 30 | 0 |
| C | 18 | 9 | 1 | 24 | 0 |
| D | 15 | 20 | 0 | 30 | 0 |
| E | 19 | 5 | 0 | 22 | 1 |

| Letter | Predicted count | True count | Predicted share |
| --- | ---: | ---: | ---: |
| A | 89 | 55 | 31.67% |
| B | 56 | 62 | 19.93% |
| C | 1 | 52 | 0.36% |
| D | 134 | 65 | 47.69% |
| E | 1 | 47 | 0.36% |

Of the 99 C/E-truth cases, 97 are wrong: **44.91% of all 216 errors**. The 134 D outputs are actual model selections, not timeout fallbacks. This is demonstrated letter-selection skew. Calling every one of those 97 cases a causal position-bias error would require controlled option permutations or other diagnostics. Such experiments were not run here.

## Inspected errors and representative successes

The first 26 incorrect predictions in the fixed development ordering were inspected, plus four correct examples. Text and OCR choices were examined for all; source images were examined where explicitly indicated below. This is a purposive sample, not a random error-prevalence survey. IDs and diagnostic notes are shown instead of reproducing restricted question contents. Full local notes are in ignored `reviews.jsonl`.

| Incorrect case ID | Predicted → truth | Supported observation; uncertainty |
| --- | --- | --- |
| `lvl-0_2017_2` | D → B | Necessary visual counts absent; source image confirms a dropped digit in one choice too. |
| `lvl-4_2013_4` | D → B | Route geometry missing; choices do not specify the path. |
| `lvl-7_2013_3` | A → E | Text calculation possible, but no option-to-letter mapping is supplied. |
| `lvl-7_2012_29` | A → E | Independent factorization confirms the label; model's failed step unknown. |
| `lvl-7_2023_18` | A → D | Required unfolding/path and visual choices unavailable. |
| `lvl-4_2011_5` | D → E | Independent enumeration confirms the label; reading/counting/mapping unresolved. |
| `lvl-6_2014_9` | D → E | Independent ratio composition confirms the label; arithmetic versus mapping unresolved. |
| `lvl-5_2016_6` | D → B | Frequencies needed for a median appear only in an unseen chart. |
| `lvl-7_2013_21` | D → B | Independent integer factor-pair check confirms the label; no model reasoning trace. |
| `lvl-4_2017_26` | D → E | Source image confirms extra leading digits in choices, including the correct choice. |
| `lvl-7_2010_19` | D → A | Factor pairs and geometric constraints verify the label; failed model operation unknown. |
| `lvl-4_2020_18` | B → C | Text-solvable percentage task lacks choices. |
| `lvl-2_2022_26` | A → D | Required graph/target-region structure and choices missing. |
| `lvl-5_2013_4` | D → C | Unavailable tile shape makes the packing input incomplete. |
| `lvl-7_2022_14` | B → C | Graph adjacency missing; node count alone is insufficient. |
| `lvl-4_2007_11` | A → C | Independent counting verifies label; counting versus mapping unresolved. |
| `lvl-6_2008_14` | A → B | Labeled geometric arrangement missing; one choice also has suspicious layout. |
| `lvl-6_2018_4` | D → A | Source image confirms superscript/expression corruption; placement also requires image. |
| `lvl-7_2021_25` | D → C | Text specifies the combinatorial task despite figure metadata; mechanism unresolved. |
| `lvl-6_2016_29` | D → C | Text probability task lacks value-to-letter mapping. |
| `lvl-6_2012_4` | D → C | Independent cancellation of two equations verifies label; arithmetic/reading/mapping unresolved. |
| `lvl-0_2017_7` | A → D | Source image confirms extra digits in the correct option; exchange calculation verifies label. |
| `lvl-5_2011_13` | D → C | Cell arrangement needed for the symmetry question is missing. |
| `lvl-7_2012_21` | A → E | Source image agrees with OCR choices; geometry reasoning needed, specific failed step unknown. |
| `lvl-7_2017_3` | D → E | Missing graph connectivity prevents reconstructing the required cut. |
| `lvl-5_2022_15` | B → D | Arrangement of regions and choices unavailable. |

Representative correct cases:

| Case ID | Result | What can be concluded |
| --- | --- | --- |
| `lvl-0_2019_22` | D, correct | Independent arithmetic supports the label; no model reasoning trace is observed. |
| `lvl-6_2009_21` | D, correct | Remaining-candidate and prime-adjacency checks support the label. |
| `lvl-2_2018_6` | D, correct | Text supplies useful perimeter structure despite figure-present metadata. |
| `lvl-5_2021_29` | B, correct | Choices are empty: correct output alone does not establish successful solution or mapping. |

## Error-category size and reliability

The following counts describe observations among **216 errors**. They overlap and must not be added as independent causes.

| Error category | Measured size / available estimate | Reliability |
| --- | --- | --- |
| Missing-input choices | 87 errors have empty options (40.28% of errors). | Exact input-property count; absence of mapping is real, but a counterfactual repair benefit was not measured. |
| Visual information | 122 errors have figure-present metadata (56.48%). Eleven inspected cases have missing visual information as the primary review finding. | Metadata is a proxy; text can sometimes suffice. Manual cases support an obstruction, not population-wide causal attribution. |
| OCR/layout | 18 errors carry heuristic flags (8.33%); four inspected wrong cases have confirmed source/OCR differences, three assigned OCR as the primary category. | Confirmed examples are reliable; flags have unknown precision/recall. Source duplication must be separated from OCR. |
| Letter-selection bias | 97 errors occur on C/E truths, while only two C/E letters are emitted. | Distribution measured exactly; fraction caused by position bias remains unknown. |
| Arithmetic failure | Two inspected clean text cases have independently verified arithmetic solutions but wrong letters. | Mechanism remains `arithmetic_or_mapping_unresolved`; **zero precisely diagnosed arithmetic-step failures**, not zero actual arithmetic errors. |
| Mathematical reasoning failure | Seven other inspected cases are `math_or_mapping_unresolved`; overall, 62 errors remain on apparently complete text inputs. | Evidence of failure on math tasks; exact reasoning/reading/mapping contribution unidentifiable from letters. |
| Output/parsing failure | 0 observed in all executed baseline runs. | Strong evidence for these runs only; malformed-server cases are not exercised by normal data. |
| Timeout/fallback | 0 observed in all executed baseline runs. | Laptop/no-RAG observation only; not a hardware guarantee. |

Primary review categories partition the 26 inspected errors as 11 missing-image, three missing-option, three confirmed-OCR, two arithmetic-or-mapping-unresolved, and seven other math-or-mapping-unresolved. The remaining 190 errors were not individually diagnosed. Do not extrapolate these proportions as causal error rates or claim that fixing OCR recovers all flagged cases.

## Reusable evaluation and next action

`benchmark/` adds a standard-library command suite for source snapshots, split audits, frozen development/final/full manifests, instrumented inference, private inspection packets, aggregate reports and paired comparisons. All nine synthetic infrastructure tests passed, covering label isolation, stable cohorts, translation grouping, exact/near index leakage checks, transparent request observation, quality flags and paired-statistic rejection paths. Both the original and current `predict.py` also completed separate five-row smoke runs with valid A–E outputs and status `ok`. Production-file bytes were checked against the starting Git version and are unchanged. [Usage and exact commands](../benchmark/README.md).

A comparison against the **existing historical** full current-solver CSV was also calculated, without implementing or rerunning that optimization: 69/281 versus 65/281, 28 fixed cases and 24 regressions, +1.42 points, paired 95% bootstrap interval −3.56 to +6.41 points, exact McNemar p=0.678. Its old laptop mean was 0.633 seconds versus 1.117 here; different historical service conditions prevent treating that difference as a controlled timing experiment. This does not demonstrate an accuracy gain. The full instrumented baseline comparison, in contrast, changed zero letters and verifies instrumentation parity.

The frozen protocol has 50 development and 231 separate final-workload IDs, plus a 281-case full manifest. All 281 had already been exposed in earlier repository experiments, so the new final manifest is **not a fresh statistical holdout**. Results, private reviews, source images and prepared data remain local under ignored directories. Nothing was committed or published.

**Next implement the conservative arithmetic/ratio solver with exact option matching and abstention described in [experiment-plan.md](experiment-plan.md).** Develop its templates on training data, remove cross-ID evaluation duplicates, and use only hidden-contract fields. This is the most actionable first optimization under the currently guaranteed inputs. Better OCR has substantial potential but requires source-image access that the hidden `predict.py` contract does not guarantee. Before claiming improvement, compare fixed/regressed cases on identical manifests and measure the accepted candidate on the UNO Q.
