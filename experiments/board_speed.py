#!/usr/bin/env python3
"""Measure how fast the model behind a llama-server port reads and writes.

    python3 experiments/board_speed.py                 # the server Reason uses
    python3 experiments/board_speed.py --port 8091     # a candidate model

Run it on the board: laptop numbers do not count. It sends the request
solve() sends, for four made-up problems, and prints tokens per second for
reading the prompt and for writing, how much of the prompt the server reused,
and what each problem cost end to end. Standard library only.

To judge a model, feed the two speeds to the saved practice-set trace:

    python3 experiments/replay.py results/trace-<run>.jsonl --repair --no-letter --near \\
        --board --read-tps <read> --write-tps <write>
"""
import argparse
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from copilot import pot  # noqa: E402
from copilot.config import CONFIG  # noqa: E402

PROBLEMS = [
    {"text": "5. How many whole numbers from 1 to 200 contain the digit 3 at least once?",
     "options": {"A": "20", "B": "36", "C": "38", "D": "40", "E": "54"}},
    {"text": "12. La Laia té el triple de cromos que en Marc. Entre tots dos en tenen 48. "
             "Quants cromos té la Laia?",
     "options": {"A": "12", "B": "16", "C": "24", "D": "32", "E": "36"}},
    {"text": "7. What is the smallest positive whole number that leaves a remainder of 2 when divided by 3, "
             "by 4 and by 5?",
     "options": {"A": "32", "B": "47", "C": "58", "D": "62", "E": "122"}},
    {"text": "9. En una cursa hi ha 30 corredors. La Berta arriba amb el triple de corredors al davant "
             "que al darrere, més un. En quina posició arriba la Berta?",
     "options": {"A": "8", "B": "21", "C": "22", "D": "23", "E": "24"}},
]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", default=CONFIG.get("REASON_LLM_PORT") or CONFIG["LLM_PORT"])
    args = p.parse_args()
    url = f"http://127.0.0.1:{args.port}/v1/chat/completions"

    model = pot.configure(url)
    print(f"Model: {model or 'unknown'}, {pot.PROFILE} profile")
    started = time.perf_counter()
    read = pot.warm_up(url, timeout=900)
    print(f"Warm-up (shared prefix): {read} tokens read in {time.perf_counter() - started:.1f} s")
    reads, writes = [], []
    for problem in PROBLEMS:
        payload = {"messages": pot._messages(problem, pot.PROGRAM_TASK), "max_tokens": pot.MAX_PROGRAM_TOKENS,
                   "temperature": 0, "seed": 42, "cache_prompt": True}
        request = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=600) as response:
            t = json.loads(response.read()).get("timings", {})
        wall = time.perf_counter() - started
        reads.append(t.get("prompt_per_second", 0))
        writes.append(t.get("predicted_per_second", 0))
        print(f"problem: {wall:5.1f} s  read {t.get('prompt_n')} tokens at {t.get('prompt_per_second', 0):.1f}/s "
              f"(reused {t.get('cache_n')}), wrote {t.get('predicted_n')} at {t.get('predicted_per_second', 0):.1f}/s")
    print(f"\nRead {sum(reads) / len(reads):.1f} tokens/s, write {sum(writes) / len(writes):.1f} tokens/s")


if __name__ == "__main__":
    main()
