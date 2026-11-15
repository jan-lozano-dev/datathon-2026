#!/usr/bin/env python3
"""Summarise a trace written by solve() when REASON_TRACE is set.

    REASON_TRACE=results/trace-x.jsonl REASON_ALWAYS_LETTER=1 python3 eval.py ...
    python3 experiments/pot_report.py results/trace-x.jsonl

It reports how often the program matched an option and how often that match
was right, and it estimates the time each problem would take on the board
from the token counts, with the speeds measured there.
"""
import argparse
import json
from collections import Counter, defaultdict

READ_TPS = 11.1   # prompt tokens per second, measured on the UNO Q
WRITE_TPS = 5.4   # generated tokens per second, measured on the UNO Q


def board_seconds(row, budget, letter_extra=1.5, exec_reserve=2.0):
    """Estimate (seconds, program_survives) for one problem on the board."""
    read = (row.get("program_prompt_n") or 0) / READ_TPS
    window = budget - (read + letter_extra) - exec_reserve - read  # seconds left for writing
    tokens = row.get("program_tokens") or 0
    survives = tokens / WRITE_TPS <= window
    spent = read + min(tokens / WRITE_TPS, max(window, 0)) + 0.5
    if not (survives and row.get("program_letter")):
        spent += read + 1.0  # the letter request reads the problem again
    return spent, survives


def table(title, groups):
    print(f"\n{title}")
    for key in sorted(groups, key=str):
        hits = groups[key]
        print(f"  {str(key):22} {sum(hits):4}/{len(hits):<4} {100 * sum(hits) / len(hits):5.1f}%")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("trace")
    p.add_argument("--budget", type=float, default=50.0)
    p.add_argument("--show", type=int, default=0, help="print this many wrong program matches")
    args = p.parse_args()

    with open(args.trace, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    rows = [r for r in rows if r.get("label")]
    n = len(rows)
    correct = [r["answer"] == r["label"] for r in rows]
    print(f"{n} problems, accuracy {sum(correct)}/{n} = {100 * sum(correct) / n:.1f}%")

    for field, title in (("method", "By method"), ("language", "By language"),
                         ("text_only", "By text_only"), ("level", "By level")):
        groups = defaultdict(list)
        for r, ok in zip(rows, correct):
            groups[r.get(field)].append(ok)
        table(title, groups)

    matched = [r for r in rows if r.get("program_letter")]
    right = sum(r["program_letter"] == r["label"] for r in matched)
    print(f"\nProgram matched one option: {len(matched)}/{n} ({100 * len(matched) / n:.0f}%), "
          f"right {right}/{len(matched) or 1} ({100 * right / (len(matched) or 1):.0f}%)")
    print("Program check:", dict(Counter(r.get("program_check", "none") for r in rows)))
    print("Program cut:  ", dict(Counter(r.get("program_cut") or "end" for r in rows)))
    errors = Counter((r.get("program_error") or "").split(":")[0] for r in rows if r.get("program_error"))
    print("Program errors:", dict(errors))
    with_letter = [r for r in rows if r.get("letter")]
    if with_letter:
        ok = sum(r["letter"] == r["label"] for r in with_letter)
        print(f"Letter alone: {ok}/{len(with_letter)} ({100 * ok / len(with_letter):.0f}%), "
              f"letters {dict(sorted(Counter(r['letter'] for r in with_letter).items()))}")
        unmatched = [r for r in with_letter if not r.get("program_letter")]
        ok = sum(r["letter"] == r["label"] for r in unmatched)
        print(f"Letter where the program gave nothing: {ok}/{len(unmatched) or 1}")

    tokens = sorted(r.get("program_tokens") or 0 for r in rows if r.get("program_tokens"))
    if tokens:
        print(f"Program tokens: median {tokens[len(tokens) // 2]}, p90 {tokens[int(len(tokens) * 0.9)]}, "
              f"max {tokens[-1]}")
        good = sorted(r["program_tokens"] for r in matched if r["program_letter"] == r["label"])
        if good:
            print(f"  of right matches: median {good[len(good) // 2]}, max {good[-1]}")
    estimates = [board_seconds(r, args.budget) for r in rows if r.get("program_prompt_n")]
    if estimates:
        seconds = sorted(s for s, _ in estimates)
        lost = sum(1 for (s, survives), r in zip(estimates, [r for r in rows if r.get("program_prompt_n")])
                   if not survives and r.get("program_letter") == r["label"])
        print(f"Board estimate ({READ_TPS} read, {WRITE_TPS} write tok/s, budget {args.budget:.0f} s): "
              f"mean {sum(seconds) / len(seconds):.0f} s, p90 {seconds[int(len(seconds) * 0.9)]:.0f} s, "
              f"max {seconds[-1]:.0f} s; right matches lost to the cut: {lost}")

    for r in [r for r in matched if r["program_letter"] != r["label"]][:args.show]:
        print(f"\n--- {r['id']} {r['language']} truth {r['label']} program said {r['program_letter']} "
              f"(printed {(r.get('program_output') or '').strip()[-40:]!r})")
        print(r.get("program_reply", ""))


if __name__ == "__main__":
    main()
