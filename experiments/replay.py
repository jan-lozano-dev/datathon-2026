#!/usr/bin/env python3
"""Re-run the steps that need no model on a saved trace, to compare policies offline.

    python3 experiments/replay.py results/trace-x.jsonl                 # as recorded
    python3 experiments/replay.py results/trace-x.jsonl --repair
    python3 experiments/replay.py results/trace-x.jsonl --prior data/letter_prior_pot.json
    python3 experiments/replay.py results/trace-x.jsonl --skip-figures --board

The trace must come from a run with REASON_ALWAYS_LETTER=1, so every problem
has both the program the model wrote and the letter it would have answered.
The programs are run again with the current extraction, repair and matching
code, so a change to those can be measured in seconds instead of minutes.
"""
import argparse
import json
import math
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from copilot import options, pot, sandbox  # noqa: E402
from copilot.config import CONFIG  # noqa: E402
from pot_report import board_seconds  # noqa: E402

LETTERS = "ABCDE"


def program_letter(row, repair):
    code = pot.extract_code(row.get("program_reply") or "")
    if repair:
        code = pot.repair(code)
    if not code.strip() or sandbox.check(code) is not None:
        return None
    output, _error = sandbox.run(code, 6.0)
    return options.match(output, row["options"])


def letter(row, prior, strength):
    scores = row.get("letter_scores") or {}
    if prior and set(scores) == set(LETTERS):
        return max(LETTERS, key=lambda l: scores[l] - strength * math.log(prior[l]))
    return row.get("letter") or CONFIG["FALLBACK_ANSWER"]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("trace", nargs="+")
    p.add_argument("--repair", action="store_true", help="apply pot.repair() to each program")
    p.add_argument("--prior", default="", help="JSON file {letter: probability} to divide the letter scores by")
    p.add_argument("--strength", type=float, default=1.0, help="how much of the prior to remove (0 to 1)")
    p.add_argument("--skip-figures", action="store_true", help="no program when text_only is false")
    p.add_argument("--board", action="store_true", help="drop programs the board would cut off for time")
    p.add_argument("--budget", type=float, default=50.0)
    args = p.parse_args()

    rows = []
    for path in args.trace:
        with open(path, encoding="utf-8") as f:
            rows += [json.loads(line) for line in f if line.strip()]
    rows = [r for r in rows if r.get("label") and r.get("options")]
    prior = json.load(open(args.prior)) if args.prior else None

    answers, methods, gained, lost = [], Counter(), 0, 0
    matched = right = 0
    for r in rows:
        found = None
        if not (args.skip_figures and r.get("text_only") is False):
            found = program_letter(r, args.repair)
            if found and args.board and not board_seconds(r, args.budget)[1]:
                found = None
        if found:
            matched += 1
            right += found == r["label"]
        answer = found or letter(r, prior, args.strength)
        methods["pot" if found else "letter"] += answer == r["label"]
        answers.append(answer)
        was, now = r["answer"] == r["label"], answer == r["label"]
        gained += now and not was
        lost += was and not now

    n = len(rows)
    correct = sum(a == r["label"] for a, r in zip(answers, rows))
    recorded = sum(r["answer"] == r["label"] for r in rows)
    print(f"{n} problems. Recorded: {recorded} ({100 * recorded / n:.1f}%). "
          f"Replayed: {correct} ({100 * correct / n:.1f}%), gained {gained}, lost {lost}")
    print(f"Program matched {matched} ({100 * matched / n:.0f}%), right {right} "
          f"({100 * right / (matched or 1):.0f}% of matches). Correct by method: {dict(methods)}")
    print("Letters answered:", dict(sorted(Counter(answers).items())),
          "true:", dict(sorted(Counter(r["label"] for r in rows).items())))
    for field in ("language", "text_only"):
        groups = {}
        for a, r in zip(answers, rows):
            groups.setdefault(r.get(field), []).append(a == r["label"])
        print(f"By {field}: " + ", ".join(f"{k}: {sum(v)}/{len(v)}" for k, v in sorted(groups.items(), key=str)))


if __name__ == "__main__":
    main()
