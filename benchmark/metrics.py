"""Descriptive metrics and strictly paired comparisons (standard library)."""
import csv
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from .common import LETTERS, key, keyed, read_jsonl


def percentile(values, q):
    """Nearest-rank percentile, including small samples."""
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)] if values else None


def latency(values):
    return {"n": len(values), "mean": statistics.mean(values) if values else None,
            "median": statistics.median(values) if values else None,
            "p95": percentile(values, .95), "maximum": max(values) if values else None}


def score(rows):
    return {"n": len(rows), "correct": sum(r["correct"] for r in rows),
            "accuracy": sum(r["correct"] for r in rows) / len(rows) if rows else None}


def load_results(path):
    path = Path(path)
    meta = None
    if path.is_dir():
        meta = json.loads((path / "run.json").read_text(encoding="utf-8"))
        if not meta["completed"]:
            raise ValueError("Incomplete run; do not report it as a finished benchmark")
        rows = read_jsonl(path / "predictions.jsonl")
        expected = meta["manifest"]["samples"]
        if [key(r) for r in rows] != [key(r) for r in expected]:
            raise ValueError("Run rows do not match ordered manifest")
    elif path.suffix == ".csv":
        with path.open(encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            r["wall_seconds"] = float(r["seconds"])
            r["correct"] = r["answer"] == r["label"]
    else:
        rows = read_jsonl(path)
    keyed(rows)
    if not rows:
        raise ValueError("Empty results")
    for r in rows:
        if r.get("label") not in list(LETTERS) or r["correct"] != (r.get("answer") == r["label"]):
            raise ValueError("Invalid label or inconsistent correctness flag")
        if not math.isfinite(r["wall_seconds"]) or r["wall_seconds"] < 0:
            raise ValueError("Invalid latency")
    return rows, meta


def summarize(rows, reviews=()):
    review_map = keyed(reviews)
    if set(review_map) - set(keyed(rows)):
        raise ValueError("Review contains samples outside this run")
    result = {**score(rows), "latency_seconds": latency([r["wall_seconds"] for r in rows]),
              "status_counts": dict(Counter(r["status"] for r in rows)),
              "fallback_count": sum(bool(r.get("fallback")) for r in rows),
              "invalid_output_count": sum(r.get("answer") not in list(LETTERS) for r in rows),
              "over_60_seconds": sum(r["wall_seconds"] > 60 for r in rows),
              "predicted_letters": {l: sum(r["answer"] == l for r in rows) for l in LETTERS},
              "true_letters": {l: sum(r["label"] == l for r in rows) for l in LETTERS},
              "confusion_matrix": {a: {b: sum(r["label"] == a and r["answer"] == b for r in rows)
                                        for b in LETTERS} for a in LETTERS}, "by": {}}
    for field in ("language", "difficulty", "topic", "complete_options", "missing_options",
                  "suspected_ocr_corruption", "duplicate_options", "image_dependent", "figure_metadata"):
        groups = defaultdict(list)
        for row in rows:
            groups[str(row.get(field, "unknown"))].append(row)
        result["by"][field] = {k: score(v) for k, v in sorted(groups.items())}
    errors = [r for r in rows if not r["correct"]]
    result["error_observations_not_causes"] = {
        "missing_options": sum(bool(r.get("missing_options")) for r in errors),
        "suspected_ocr_corruption": sum(bool(r.get("suspected_ocr_corruption")) for r in errors),
        "image_dependency_suspected": sum(r.get("image_dependent") == "suspected" for r in errors),
        "timeout": sum(r["status"] == "timeout" for r in errors),
        "invalid_output": sum(r["answer"] not in list(LETTERS) for r in errors),
        "apparently_complete_text_input": sum(bool(r.get("complete_options")) and
            r.get("image_dependent") == "not_indicated" and not r.get("suspected_ocr_corruption") for r in errors)}
    result["reviewed_errors"] = sum(key(r) in review_map for r in errors)
    result["review_categories"] = dict(Counter(review_map[key(r)]["category"] if key(r) in review_map
                                                else "unreviewed" for r in errors))
    result["review_sampling_note"] = "Purposive inspection; category frequencies cannot estimate population causes."
    result["always_D_accuracy"] = sum(r["label"] == "D" for r in rows) / len(rows)
    result["tokens"] = {field: latency([r[field] for r in rows if r.get(field) is not None])
                        for field in ("prompt_tokens", "prompt_tokens_processed", "prompt_tokens_cached", "generated_tokens")}
    return result


def markdown(summary):
    s = summary
    lines = [f"Accuracy: {s['correct']}/{s['n']} ({100*s['accuracy']:.2f}%).",
             "", "Latency is wall-clock time in seconds; p95 uses nearest rank.", "",
             "| Mean | Median | p95 | Maximum |", "| ---: | ---: | ---: | ---: |",
             "| " + " | ".join(f"{s['latency_seconds'][k]:.4f}" for k in ("mean", "median", "p95", "maximum")) + " |",
             "", f"Statuses: `{s['status_counts']}`. Invalid outputs: {s['invalid_output_count']}; over 60 s: {s['over_60_seconds']}.",
             "", "Confusion matrix: rows = truth, columns = prediction.", "",
             "| Truth | A | B | C | D | E |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for a in LETTERS:
        lines.append(f"| {a} | " + " | ".join(str(s['confusion_matrix'][a][b]) for b in LETTERS) + " |")
    lines += ["", f"Predicted letters: `{s['predicted_letters']}`.", f"True letters: `{s['true_letters']}`."]
    for field, groups in s["by"].items():
        lines += ["", field + ":", "", "| Group | Correct / n | Accuracy |", "| --- | ---: | ---: |"]
        for k, v in groups.items():
            lines.append(f"| {k} | {v['correct']} / {v['n']} | {100*v['accuracy']:.2f}% |")
    lines += ["", "Error observations overlap and are not causal diagnoses:", "",
              "```json", json.dumps(s["error_observations_not_causes"], indent=2), "```", "",
              f"Inspected incorrect predictions: {s['reviewed_errors']}.",
              f"Inspection categories: `{s['review_categories']}`.", s["review_sampling_note"]]
    return "\n".join(lines) + "\n"


def compare(left, right, seed=42, samples=5000):
    a, ma = load_results(left)
    b, mb = load_results(right)
    if [key(r) for r in a] != [key(r) for r in b]:
        raise ValueError("Paired comparison requires identical IDs, languages AND ordering")
    if ma and mb and ma["manifest"]["manifest_sha256"] != mb["manifest"]["manifest_sha256"]:
        raise ValueError("Different manifests; cannot compare as the same experiment set")
    for x, y in zip(a, b):
        if x["label"] != y["label"] or (x.get("input_sha256") and y.get("input_sha256") and
                                       x["input_sha256"] != y["input_sha256"]):
            raise ValueError("Labels or inference inputs differ")
    fixed = [list(key(x)) for x, y in zip(a, b) if not x["correct"] and y["correct"]]
    regressed = [list(key(x)) for x, y in zip(a, b) if x["correct"] and not y["correct"]]
    clusters = defaultdict(list)
    for x, y in zip(a, b):
        clusters[x["id"]].append(int(y["correct"]) - int(x["correct"]))
    units = list(clusters.values())
    rng = random.Random(seed)
    boot = []
    for _ in range(samples):
        chosen = [rng.choice(units) for _ in units]
        boot.append(100 * sum(sum(c) for c in chosen) / sum(len(c) for c in chosen))
    discordant = len(fixed) + len(regressed)
    # McNemar is appropriate here only if each problem ID appears once.
    p = min(1.0, 2 * sum(math.comb(discordant, k) / 2**discordant
                        for k in range(min(len(fixed), len(regressed)) + 1))) if discordant else 1.0
    return {"n": len(a), "left": str(left), "right": str(right),
            "left_accuracy": score(a)["accuracy"], "right_accuracy": score(b)["accuracy"],
            "difference_percentage_points": 100 * (len(fixed)-len(regressed)) / len(a),
            "fixed": fixed, "regressions": regressed,
            "changed_answers": sum(x["answer"] != y["answer"] for x, y in zip(a, b)),
            "paired_cluster_bootstrap_95_percent": [percentile(boot, .025), percentile(boot, .975)],
            "bootstrap_clusters": "problem ID (translations kept together)", "seed": seed, "bootstrap_samples": samples,
            "mcnemar_exact_p": p if len(units) == len(a) else None,
            "left_latency_seconds": latency([x["wall_seconds"] for x in a]),
            "right_latency_seconds": latency([x["wall_seconds"] for x in b]),
            "paired_latency_delta_seconds": latency([y["wall_seconds"] - x["wall_seconds"] for x, y in zip(a, b)]),
            "latency_comparable_hardware": bool(ma and mb and ma["hardware"]['hardware_label'] == mb["hardware"]['hardware_label']
                                                and ma["hardware"]['machine'] == mb["hardware"]['machine']),
            "limitations": "Exploratory after repeated validation use; shared statements under different IDs can still be dependent. Match server/cache/load conditions for latency."}
