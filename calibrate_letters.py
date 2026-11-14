#!/usr/bin/env python3
"""Estimate the model's A-E label bias from cyclic option rotations.

Run with the local llama-server ready: python3 calibrate_letters.py
Writes only five aggregate probabilities to data/letter_prior.json. This file
is ignored by git and must be generated on each device before prediction.
"""
import argparse
import json
import os
import random

from copilot.calibration import DEFAULT_PATH, LETTERS, normalize_scores, prompt_fingerprint
from copilot.llm import answer_letter


def rotate(problem, shift):
    rotated = dict(problem)
    values = [problem["options"][letter] for letter in LETTERS]
    rotated["options"] = {letter: values[(i - shift) % 5]
                          for i, letter in enumerate(LETTERS)}
    return rotated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="data/train.jsonl")
    parser.add_argument("--output", default=DEFAULT_PATH)
    parser.add_argument("--problems", type=int, default=20)
    args = parser.parse_args()
    with open(args.input, encoding="utf-8") as source:
        problems = [p for line in source if (p := json.loads(line)).get("options")
                    and set(LETTERS) <= set(p["options"])]
    random.Random(42).shuffle(problems)
    selected = problems[:args.problems]
    if len(selected) < args.problems:
        parser.error("not enough training problems with all five OCR options")
    totals = {letter: 0.0 for letter in LETTERS}
    count = 0
    for number, problem in enumerate(selected, 1):
        for shift in range(5):
            _letter, _timings, scores = answer_letter(rotate(problem, shift), with_scores=True)
            probabilities = normalize_scores(scores)
            if probabilities is None:
                _letter, _timings, scores = answer_letter(rotate(problem, shift),
                                                           with_scores=True, top_logprobs=2048)
                probabilities = normalize_scores(scores)
            if probabilities is None:
                raise RuntimeError(f"missing letter logprobs on problem {number}, rotation {shift}")
            for letter in LETTERS:
                totals[letter] += probabilities[letter]
            count += 1
        print(f"{number}/{len(selected)} training problems", flush=True)
    prior = {letter: totals[letter] / count for letter in LETTERS}
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as target:
        json.dump({"prior": prior, "rotations": count, "fingerprint": prompt_fingerprint()},
                  target, indent=2)
        target.write("\n")
    print(f"Saved {count} rotations to {args.output}: {prior}")


if __name__ == "__main__":
    main()
