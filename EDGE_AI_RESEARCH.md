# Edge AI research for the M3Kang reasoner

Research snapshot: 14 November 2026. These papers motivate experiments; their reported gains are not predictions for our UNO Q or M3Kang split.

## Current constraints and evidence

- Arduino UNO Q: 4 GB RAM, offline execution, 60 seconds per problem. The earlier Qwen3.5 0.8B model read about 11 tokens/s and wrote about 6 tokens/s on the board. Qwen2.5-Coder-1.5B scored 19/40 on a board practice run (31.5 s mean, 53.1 s worst, 4 timeouts); RAM was not recorded.
- `predict.py` emits one A–E letter. The saved 200-problem English validation run scored 45/200 (22.5%); always D would score 48/200 (24%). Predictions were A:63, B:36, C:0, D:101, E:0. The recorded 1.2 s mean is not a board benchmark.
- Local data: 1,466 English training and 281 English validation problems. OCR recovered options for 1,078/1,747. The normal solver does not see figures.
- M3Kang's question text excludes answer choices, which live in the image; some diagrams contain essential information. Source: `dataset-paper.pdf` (Torres-Camps et al., 2026, https://arxiv.org/abs/2601.16218).

## Relevant research and possible experiments

| Finding | Primary source | UNO Q experiment and caveat |
| --- | --- | --- |
| Multiple-choice models exhibit option-ID bias; PriDe estimates and removes a label prior using option permutations. | Zheng et al., ICLR 2024, https://proceedings.iclr.cc/paper_files/paper/2024/file/54dd9e0cff6d9214e20d97eb2a3bae49-Paper-Conference.pdf | Estimate A–E prior once from rotated training questions, then subtract log-prior from one-call A–E scores. Validate on untouched problems. |
| Option order alone can change answers. | Pezeshkpour and Hruschka, NAACL 2024, https://aclanthology.org/2024.findings-naacl.130/ | Try deterministic answer-option rotation and map back to original letters. One call at inference, but no guaranteed gain. |
| First-token probabilities can disagree with a model's freely generated answer. | Wang et al., ACL 2024, https://aclanthology.org/2024.findings-acl.441/ | Keep the production A–E grammar and compare calibrated decisions with the existing constrained baseline. Do not assume raw first-token scores measure open-ended reasoning. |
| Exact computation can be separated from language interpretation; edge routing can reserve the model for harder cases. | Chen et al., Program-of-Thoughts, https://arxiv.org/abs/2211.12588 ; 2026 edge routing preprint, https://arxiv.org/abs/2609.35833 | Add conservative standard-library arithmetic/percentage solvers when options are readable. The 2026 preprint used different tasks and hardware; its accuracy is not transferable. |
| Confidence and task features can guide test-time compute allocation. | Adaptive compute preprint, https://arxiv.org/abs/2604.14853 ; confidence study, https://mlanthology.org/tmlr/2025/plaut2025tmlr-probabilities/ | Route problems by OCR availability, `text_only`, and A–E score margin. Fit thresholds on training data only; evaluate answer accuracy under the 60-second limit. |
| Quantization often retains reasoning ability, and model training matters at a given size. A dedicated 1.5B math model exists. | ThinkSLM, EMNLP 2025, https://aclanthology.org/2025.emnlp-main.1659/ ; Qwen model card, https://huggingface.co/Qwen/Qwen2.5-Math-1.5B-Instruct | Compare quantized models on exactly the same M3Kang subset and on the board. Published math scores often use long reasoning or tools, so they cannot be compared with one-letter output. |
| Retrieved mathematical text can be structurally misleading; concise method instructions are a different retrieval target. | MathNet, ICLR 2026, https://mathnet.mit.edu/paper.pdf ; instruction retrieval preprint, https://arxiv.org/abs/2510.13935 | Retrieve short topic-specific procedures only when similarity is convincing. Full RAG examples cost too many input tokens unless they clearly improve accuracy. |
| Dense reasoning and short reasoning traces are active research topics for small models. | DenseSteer, ICML 2026, https://proceedings.mlr.press/v306/ouyang26d.html ; Efficient Reasoning on the Edge, https://arxiv.org/abs/2603.16867 | Lower priority here: the current output is already one token, and representation steering or adapters need more engineering than a calibration experiment. |

## Priority and measurement

1. Correct answer-letter bias using a one-call score and a prior estimated only from training questions.
2. Add narrow exact solvers for problems with unambiguous text and options.
3. Route by confidence and available information; only then test a larger quantized math model or selective method retrieval.

Each experiment should use the same validation order and report accuracy, predicted-letter distribution, accuracy by `text_only` and OCR availability, latency, `prompt_n`, `cache_n`, and generated tokens. Only board runs establish compliance with 60 seconds. The pinned llama.cpp documentation distinguishes tokens processed from tokens reused: https://raw.githubusercontent.com/ggml-org/llama.cpp/2cbe0ec429b849a88664e0f62388fc92a5abd699/tools/server/README.md .

## Letter-prior experiment, 14 November 2026

`calibrate_letters.py` averaged the A–E model probabilities over all five cyclic option rotations of 20 English training problems (100 calls). The saved prior is local in ignored `data/letter_prior.json`. We requested raw `top_logprobs` from the pinned llama.cpp server; these are taken before the A–E grammar, so five candidates were insufficient. The implementation requests 512 and retries 2048 during prior estimation if any letter is missing.

With full prior correction on questions with OCR options, the original 200-question validation sample moved from 45/200 to 47/200. Among 119 questions with options, 75 answers changed: 19 gains and 17 losses. This was below the always-D score of 48/200. On 145 separate training questions, baseline scored 27, while correction strengths 0.75 and 1.25 scored 30. On the 81 validation questions outside the original sample, baseline and full correction both scored 20, while 0.75 scored 19. The signal is too weak to ship; calibration is off by default. Set `LETTER_CALIBRATION=1` only to reproduce the experiment. Re-run `calibrate_letters.py` after any model or prompt implementation change.

## No-options routing experiment, 14 November 2026

For a fixed random sample of 120 training problems whose OCR options were empty, the text model scored 19/120 and always D scored 37/120. On the original 200 validation questions, the no-options subset scored 19/81 with the model and 23/81 with D. On the other 81 validation questions, the no-options subset tied at 8/33. This supports bypassing the text model when it cannot see answer choices. It also saves the full model-call latency for those questions. This is a different intervention from letter-score calibration; keep its evaluation separate.

The default route scored 49/200 (24.5%) on the original comparison and 69/281 (24.6%) on full validation, compared with 45/200 for the saved model baseline and 65/281 for always D. The 119 OCR-option predictions in the paired 200-question comparison were unchanged. Full-validation accuracy was 31/114 without OCR options and 38/167 with them. Local mean latency was 0.6 seconds per problem; board latency has not yet been measured.
