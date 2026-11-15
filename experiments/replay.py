#!/usr/bin/env python3
"""Re-run the steps that need no model on a saved trace, to compare policies offline.

    python3 experiments/replay.py results/trace-x.jsonl --repair --no-letter --near   # what solve() does now
    python3 experiments/replay.py results/trace-x.jsonl --repair                      # the earlier plan
    python3 experiments/replay.py results/trace-x.jsonl --repair --no-letter --near --board \\
        --read-tps 4.8 --write-tps 2.3                                                # at another board speed

The programs saved in the trace are run again with the current extraction,
repair and matching code, so a change to those can be measured in seconds
instead of minutes. Options that involve the letter (--prior, --strength, and
leaving out --no-letter) need a trace recorded with REASON_ALWAYS_LETTER=1.
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
from pot_report import READ_TPS, WRITE_TPS, board_seconds  # noqa: E402

LETTERS = "ABCDE"


def program_letter(row, repair):
    """Return (letter of the option the program's output equals, letter of the nearest option)."""
    code = pot.extract_code(row.get("program_reply") or "")
    if repair:
        code = pot.repair(code)
    if not code.strip() or sandbox.check(code) is not None:
        return None, None
    output, _error = sandbox.run(code, 6.0)
    return options.match(output, row["options"]), options.nearest(output, row["options"])


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
    p.add_argument("--budget", type=float, default=55.0)
    p.add_argument("--read-tps", type=float, default=READ_TPS, help="with --board: prompt tokens per second")
    p.add_argument("--write-tps", type=float, default=WRITE_TPS, help="with --board: generated tokens per second")
    p.add_argument("--reuse", action="store_true", help="with --board: the server can skip a statement it just read")
    p.add_argument("--no-letter", action="store_true",
                   help="never ask for the letter: answer FALLBACK_ANSWER, and give that time to the program")
    p.add_argument("--near", action="store_true",
                   help="when the output is a number between the options, answer the nearest one")
    args = p.parse_args()

    rows = []
    for path in args.trace:
        with open(path, encoding="utf-8") as f:
            rows += [json.loads(line) for line in f if line.strip()]
    rows = [r for r in rows if r.get("label") and r.get("options")]
    prior = json.load(open(args.prior)) if args.prior else None

    answers, methods, gained, lost = [], Counter(), 0, 0
    matched = right = near_used = near_right = 0
    for r in rows:
        found = near = None
        if not (args.skip_figures and r.get("text_only") is False):
            found, near = program_letter(r, args.repair)
            if args.board and not board_seconds(r, args.budget, args.read_tps, args.write_tps,
                                                args.reuse, ask_letter=not args.no_letter)[1]:
                found = near = None
        if found:
            matched += 1
            right += found == r["label"]
        elif near and args.near:
            near_used += 1
            near_right += near == r["label"]
        else:
            near = None
        answer = found or near or (CONFIG["FALLBACK_ANSWER"] if args.no_letter
                                   else letter(r, prior, args.strength))
        methods["pot" if found else "near" if near else "fallback"] += answer == r["label"]
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
    if args.near:
        print(f"Nearest option used {near_used} times, right {near_right}")
    print("Letters answered:", dict(sorted(Counter(answers).items())),
          "true:", dict(sorted(Counter(r["label"] for r in rows).items())))
    for field in ("language", "text_only"):
        groups = {}
        for a, r in zip(answers, rows):
            groups.setdefault(r.get(field), []).append(a == r["label"])
        print(f"By {field}: " + ", ".join(f"{k}: {sum(v)}/{len(v)}" for k, v in sorted(groups.items(), key=str)))


if __name__ == "__main__":
    main()
