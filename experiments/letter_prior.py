#!/usr/bin/env python3
"""Estimate how much the model favours each letter, whatever the problem says.

    python3 experiments/letter_prior.py --input data/dev_calib.jsonl

For every problem it asks for one letter, exactly as solve() does when the
program step gives nothing, and averages the probability of A to E over all
problems. With labels spread evenly, a fair model would average 0.2 each;
what it gives instead is its bias. Paste the printed dictionary into
copilot/pipeline.py as LETTER_PRIOR, and rerun this after any change to the
shared prompt in copilot/pot.py or to the model.
"""
import argparse
import json
import math
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from copilot import pot  # noqa: E402
from copilot.llm import URL  # noqa: E402

LETTERS = "ABCDE"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default="data/dev_calib.jsonl")
    p.add_argument("--out", default="data/letter_prior_pot.json")
    p.add_argument("--trace", default="", help="also save every problem's scores, for experiments/replay.py")
    args = p.parse_args()

    with open(args.input, encoding="utf-8") as f:
        problems = [json.loads(line) for line in f if line.strip()]
    totals, raw, used, hits = dict.fromkeys(LETTERS, 0.0), Counter(), 0, 0
    trace = open(args.trace, "w", encoding="utf-8") if args.trace else None
    for n, problem in enumerate(problems, 1):
        letter, scores, _timings = pot.ask_letter(problem, URL, timeout=120)
        raw[letter] += 1
        hits += letter == problem.get("label")
        if trace:
            row = {key: problem.get(key) for key in ("id", "language", "level", "text_only", "label", "options")}
            row.update(answer=letter, method="letter", letter=letter, letter_scores=scores)
            trace.write(json.dumps(row, ensure_ascii=False) + "\n")
        if set(scores) != set(LETTERS):
            continue
        top = max(scores.values())
        weights = {l: math.exp(scores[l] - top) for l in LETTERS}
        norm = sum(weights.values())
        for l in LETTERS:
            totals[l] += weights[l] / norm
        used += 1
        if n % 50 == 0:
            print(f"  {n}/{len(problems)}", flush=True)
    prior = {l: round(totals[l] / used, 4) for l in LETTERS}
    with open(args.out, "w") as out:
        json.dump(prior, out)
    print(f"{used}/{len(problems)} problems with all five scores; letter alone was right {hits}/{len(problems)}")
    print("Letters chosen:", dict(sorted(raw.items())), "true:",
          dict(sorted(Counter(p.get("label") for p in problems).items())))
    print(f"LETTER_PRIOR = {prior}")
    print(f"Saved to {args.out}")


if __name__ == "__main__":
    main()
