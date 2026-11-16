"""Freeze evaluation order and audit splits without publishing problem text."""
import difflib
import json
import random
import sqlite3
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from .common import (digest, file_hash, git, inference_input, key, keyed, normalized,
                     quality, read_jsonl, source_info, stamp, stem_hash, write_json)


def snapshot(root, ref, target):
    root, target = Path(root).resolve(), Path(target)
    commit = git(["rev-parse", ref], root)
    if target.exists():
        raise ValueError("Snapshot destination already exists")
    files = ["predict.py", "eval.py", "build_index.py", "config.env"]
    files += git(["ls-tree", "-r", "--name-only", commit, "copilot"], root).splitlines()
    for name in files:
        p = target / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(subprocess.check_output(["git", "show", f"{commit}:{name}"], cwd=root))
    info = source_info(target)
    write_json(target / "baseline-source.json", {"commit": commit, "files": info["files"]})
    return source_info(target)


def prepare(input_path, target, dev_size=50, seed=42):
    rows = read_jsonl(input_path)
    keyed(rows)
    if not rows or dev_size < 1:
        raise ValueError("Need nonempty data and positive dev size")
    random.Random(seed).shuffle(rows)  # identical to eval.py before limiting
    dev_ids = {r["id"] for r in rows[:dev_size]}
    # Keep all translations of development IDs away from final evaluation.
    selections = {"dev": [r for r in rows if r["id"] in dev_ids],
                  "final": [r for r in rows if r["id"] not in dev_ids], "full": rows}
    target = Path(target)
    if any((target / f"{name}.json").exists() for name in selections):
        raise ValueError("Manifests already exist; use a new versioned directory")
    for name, subset in selections.items():
        spec = {"schema": 1, "name": name, "seed": seed, "created_utc": stamp(),
                "dataset_sha256": file_hash(input_path), "dataset_rows": len(rows),
                "input_fields": list(inference_input(rows[0])),
                "selection": "eval.py shuffle; dev ID groups; remaining IDs final",
                "samples": [{"id": r["id"], "language": r.get("language", ""),
                             "input_sha256": digest(inference_input(r))} for r in subset]}
        spec["manifest_sha256"] = digest({k: v for k, v in spec.items() if k != "created_utc"})
        write_json(target / f"{name}.json", spec)
    return {name: len(rows) for name, rows in selections.items()}


def select(input_path, manifest_path):
    spec = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if digest({k: v for k, v in spec.items() if k not in ("created_utc", "manifest_sha256")}) != spec["manifest_sha256"]:
        raise ValueError("Manifest digest mismatch")
    if file_hash(input_path) != spec["dataset_sha256"]:
        raise ValueError("Dataset bytes changed; freeze a new manifest version")
    rows = keyed(read_jsonl(input_path))
    selected = []
    seen = set()
    for sample in spec["samples"]:
        k = key(sample)
        if k in seen:
            raise ValueError("Repeated sample in manifest")
        seen.add(k)
        row = rows[k]
        if digest(inference_input(row)) != sample["input_sha256"]:
            raise ValueError(f"Inference input changed: {k}")
        selected.append(row)
    if not selected:
        raise ValueError("Manifest is empty")
    return spec, selected


def audit(train_path, val_path, near_threshold=0.92):
    train, val = read_jsonl(train_path), read_jsonl(val_path)
    groups = {}
    for name, rows, path in (("train", train, train_path), ("val", val, val_path)):
        qc = [quality(r) for r in rows]
        stems = Counter(stem_hash(r) for r in rows if normalized(r.get("text", "")))
        keys = Counter(key(r) for r in rows)
        groups[name] = {"rows": len(rows), "unique_ids": len({r["id"] for r in rows}),
                        "sha256": file_hash(path), "languages": dict(Counter(r.get("language") for r in rows)),
                        "levels": dict(Counter(str(r.get("level")) for r in rows)),
                        "invalid_labels": sum(r.get("label") not in list("ABCDE") for r in rows),
                        "duplicate_keys": [list(k) for k, n in keys.items() if n > 1],
                        "duplicate_stem_groups": sum(n > 1 for n in stems.values()),
                        "quality_counts": {k: sum(q[k] is True for q in qc) for k in
                            ("complete_options", "missing_options", "duplicate_options", "suspected_ocr_corruption", "figure_metadata", "figure_text_cue")},
                        "ocr_flag_counts": dict(Counter(flag for q in qc for flag in q["ocr_flags"])),
                        "image_dependence": dict(Counter(q["image_dependent"] for q in qc)),
                        "hash_split_mismatches": sum(
                            (int(__import__('hashlib').sha256(r['id'].encode()).hexdigest(), 16) % 1000 < 150) != (name == 'val') for r in rows)}
    train_ids = {r["id"] for r in train}
    train_stems = defaultdict(list)
    for r in train:
        if normalized(r.get("text", "")):
            train_stems[stem_hash(r)].append(r)
    exact, near = [], []
    for r in val:
        for t in train_stems.get(stem_hash(r), []):
            exact.append({"train": list(key(t)), "val": list(key(r))})
        a = normalized(r.get("text", ""), strip_number=True)
        if len(a) < 30:
            continue
        for t in train:
            b = normalized(t.get("text", ""), strip_number=True)
            if t.get("language") != r.get("language") or a == b or not b:
                continue
            if min(len(a), len(b)) / max(len(a), len(b)) < near_threshold:
                continue
            matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
            if matcher.quick_ratio() >= near_threshold:
                score = matcher.ratio()
                if score >= near_threshold:
                    near.append({"train": list(key(t)), "val": list(key(r)), "similarity": round(score, 4)})
    return {"created_utc": stamp(), "splits": groups,
            "shared_ids": sorted(train_ids & {r["id"] for r in val}),
            "exact_normalized_stem_pairs": exact, "near_stem_candidates": near,
            "near_threshold": near_threshold,
            "limitations": ["Near matches are candidates, not proven duplicates.",
                            "No semantic cross-language detector; shared IDs catch canonical translations.",
                            "OCR flags and figure metadata do not prove causal inference failures."]}


def check_index(index_path, train_path, val_path):
    """Reject non-training records and conservative exact/near leakage candidates."""
    train = keyed(read_jsonl(train_path))
    val = read_jsonl(val_path)
    val_ids = {r["id"] for r in val}
    val_stems = {stem_hash(r) for r in val if normalized(r.get("text", ""))}
    # A once-per-run audit is outside per-problem inference. Conservative false
    # positives are preferable to silently accepting a repeated evaluation task.
    overlap = audit(train_path, val_path)
    near_train_keys = {tuple(pair["train"]) for pair in overlap["near_stem_candidates"]}
    count = 0
    uri = Path(index_path).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        for stored_key, raw in db.execute("SELECT key, problem FROM problems"):
            r = json.loads(raw)
            k = key(r)
            if k not in train or r != train[k] or stored_key != "|".join(k):
                raise ValueError(f"Index record is not identical to training: {k}")
            if r["id"] in val_ids or stem_hash(r) in val_stems or k in near_train_keys:
                raise ValueError(f"Validation ID/translation/exact or near stem in index: {k}")
            count += 1
    if count == 0:
        raise ValueError("Empty retrieval index")
    return {"rows": count, "index_sha256": file_hash(index_path),
            "train_sha256": file_hash(train_path), "validation_sha256": file_hash(val_path),
            "near_similarity_threshold": overlap["near_threshold"],
            "guard": "training membership + exact record equality + validation IDs/exact/near stems"}
