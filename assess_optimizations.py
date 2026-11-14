#!/usr/bin/env python3
"""Paired four-way evaluation of the two reasoner optimizations.

The model is called once per question. All four decisions use that response,
which avoids differences caused by prompt cache state between separate runs.
Writes per-problem diagnostics only under ignored results/.
"""
import argparse
import csv
import json
import math
import os
import random
import statistics
import time
from collections import Counter

from copilot.calibration import choose, load_prior
from copilot.config import CONFIG
from copilot.llm import answer_letter

METHODS = ("baseline", "calibration", "no_options", "both")


def interval(hits, n):
    """95% Wilson interval for one accuracy proportion."""
    z = 1.96
    p = hits / n
    center = (p + z * z / (2 * n)) / (1 + z * z / n)
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return center - radius, center + radius


def paired_interval(rows, method, draws=10000):
    """Paired bootstrap interval for improvement in accuracy, in points."""
    changes = [int(r[method] == r["label"]) - int(r["baseline"] == r["label"])
               for r in rows]
    rng = random.Random(42)
    n = len(changes)
    samples = sorted(100 * sum(changes[rng.randrange(n)] for _ in range(n)) / n
                     for _ in range(draws))
    return samples[int(0.025 * draws)], samples[int(0.975 * draws)]


def mcnemar_p(gained, lost):
    """Exact two-sided sign test on the discordant paired outcomes."""
    n = gained + lost
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, k) for k in range(min(gained, lost) + 1)) / 2**n)


def summarize(rows):
    n = len(rows)
    no_options = [r for r in rows if not r["has_options"]]
    print(f"Paired questions: {n}; OCR options: {sum(r['has_options'] for r in rows)}; "
          f"text-only: {sum(r['text_only'] for r in rows)}")
    print("method         correct     95% Wilson       gain/loss vs base    delta 95% CI    p")
    for method in METHODS:
        hits = sum(r[method] == r["label"] for r in rows)
        lo, hi = interval(hits, n)
        if method == "baseline":
            print(f"{method:13} {hits:3}/{n:<3} {100 * hits / n:5.1f}%  "
                  f"[{100 * lo:4.1f}, {100 * hi:4.1f}]%")
            continue
        gained = sum(r[method] == r["label"] and r["baseline"] != r["label"] for r in rows)
        lost = sum(r[method] != r["label"] and r["baseline"] == r["label"] for r in rows)
        d_lo, d_hi = paired_interval(rows, method)
        print(f"{method:13} {hits:3}/{n:<3} {100 * hits / n:5.1f}%  "
              f"[{100 * lo:4.1f}, {100 * hi:4.1f}]%  "
              f"+{gained}/-{lost}  [{d_lo:+4.1f}, {d_hi:+4.1f}] pp  "
              f"p={mcnemar_p(gained, lost):.3f}")
    floor = sum(r["label"] == CONFIG["FALLBACK_ANSWER"] for r in rows)
    print(f"always {CONFIG['FALLBACK_ANSWER']:7} {floor:3}/{n:<3} {100 * floor / n:5.1f}%")
    for field in ("has_options", "text_only"):
        for value in (False, True):
            group = [r for r in rows if r[field] is value]
            counts = " ".join(f"{m}:{sum(r[m] == r['label'] for r in group)}/{len(group)}"
                              for m in METHODS)
            print(f"{field}={value}: {counts}")
    for method in METHODS:
        print(f"{method} letters: {dict(Counter(r[method] for r in rows))}")
    print(f"Missing A-E scores after retry: {sum(not r['scores_complete'] for r in rows)}")
    print(f"Measured model-call mean: {statistics.mean(r['model_seconds'] for r in rows):.2f}s; "
          f"maximum: {max(r['model_seconds'] for r in rows):.2f}s")
    print(f"Calls needed with no-options routing: {n - len(no_options)}/{n}")
    print(f"No-options calls avoided: {len(no_options)}/{n}; "
          f"measured local call time avoided: "
          f"{sum(r['model_seconds'] for r in no_options):.1f}s/"
          f"{sum(r['model_seconds'] for r in rows):.1f}s")
    print(f"timings.prompt_n avoided: {sum(int(r['prompt_n']) for r in no_options)}")
    print("This call timing includes probability extraction on questions with options; "
          "use eval.py for production-path latency.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="data/val.jsonl")
    parser.add_argument("--output", default="results/optimization-paired.csv")
    parser.add_argument("--limit", type=int, default=0, help="0 means all questions")
    parser.add_argument("--from-results", action="store_true",
                        help="summarize an existing CSV without calling the model")
    args = parser.parse_args()
    if args.from_results:
        with open(args.output, newline="", encoding="utf-8") as source:
            rows = list(csv.DictReader(source))
        for row in rows:
            for field in ("text_only", "has_options", "scores_complete"):
                row[field] = row[field] == "True"
            row["model_seconds"] = float(row["model_seconds"])
        summarize(rows)
        return
    prior = load_prior()
    if prior is None:
        parser.error("run calibrate_letters.py first to create data/letter_prior.json")
    with open(args.input, encoding="utf-8") as source:
        problems = [json.loads(line) for line in source if line.strip()]
    random.Random(42).shuffle(problems)
    if args.limit:
        problems = problems[:args.limit]
    rows = []
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    fields = ("id", "language", "level", "text_only", "has_options", "label", *METHODS,
              "model_seconds", "prompt_n", "cache_n", "predicted_n", "scores_complete")
    with open(args.output, "w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader()
        for number, problem in enumerate(problems, 1):
            has_options = bool(problem.get("options"))
            started = time.perf_counter()
            if has_options:
                baseline, timings, scores = answer_letter(problem, with_scores=True)
                if len(scores) < 5:
                    baseline, timings, scores = answer_letter(problem, with_scores=True,
                                                             top_logprobs=2048)
                calibration = choose(scores, prior) or baseline
            else:
                baseline, timings = answer_letter(problem)
                scores = {}
                calibration = baseline
            elapsed = time.perf_counter() - started
            row = {"id": problem["id"], "language": problem["language"],
                   "level": problem["level"], "text_only": problem["text_only"],
                   "has_options": has_options, "label": problem["label"],
                   "baseline": baseline, "calibration": calibration,
                   "no_options": baseline if has_options else CONFIG["FALLBACK_ANSWER"],
                   "both": calibration if has_options else CONFIG["FALLBACK_ANSWER"],
                   "model_seconds": round(elapsed, 3),
                   "prompt_n": timings.get("prompt_n", 0),
                   "cache_n": timings.get("cache_n", 0),
                   "predicted_n": timings.get("predicted_n", 0),
                   "scores_complete": not has_options or len(scores) == 5}
            writer.writerow(row)
            target.flush()
            rows.append(row)
            if number % 50 == 0 or number == len(problems):
                print(f"{number}/{len(problems)}", flush=True)
    summarize(rows)
    print(f"Diagnostics: {args.output}")


if __name__ == "__main__":
    main()
