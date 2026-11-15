#!/usr/bin/env python3
"""Build fixed development subsets from the M3Kang training split, on the laptop.

    python3 experiments/make_dev_sets.py

Prompts and rules are tuned on these, never on validation or on the practice
set, so those stay honest checks. The output goes to data/, which Git ignores.

Both hold text-only problems with five options, the kind the practice set has:

- data/dev_pot.jsonl: to tune the program step, whose output is checked
  against the options.
- data/dev_calib.jsonl: different problems, to estimate the letter bias.
"""
import argparse
import json
import random


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default="data/train.jsonl")
    p.add_argument("--dev", type=int, default=150)
    p.add_argument("--calib", type=int, default=200)
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args()

    with open(args.input, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    rows = [r for r in rows if len(r.get("options") or {}) == 5 and r["text_only"]]
    random.Random(args.seed).shuffle(rows)
    dev = rows[:args.dev]
    calib = rows[args.dev:args.dev + args.calib]
    for name, subset in (("data/dev_pot.jsonl", dev), ("data/dev_calib.jsonl", calib)):
        with open(name, "w", encoding="utf-8") as out:
            for r in subset:
                out.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"{name}: {len(subset)} problems")


if __name__ == "__main__":
    main()
