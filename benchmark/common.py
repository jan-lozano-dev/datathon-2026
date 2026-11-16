"""Data contracts, conservative quality flags, and reproducibility helpers."""
import hashlib
import json
import re
import subprocess
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

LETTERS = "ABCDE"
INPUT_FIELDS = ("id", "text", "options", "language")


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_jsonl(path):
    with Path(path).open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def key(row):
    return str(row["id"]), str(row.get("language", ""))


def keyed(rows):
    result = {}
    for row in rows:
        k = key(row)
        if k in result:
            raise ValueError(f"Duplicate (id, language): {k}")
        result[k] = row
    return result


def inference_input(row):
    # No labels, answer keys, topic annotations or split metadata enter inference.
    return {field: row[field] for field in INPUT_FIELDS if field in row}


def normalized(text, strip_number=False):
    text = unicodedata.normalize("NFKC", str(text)).casefold()
    if strip_number:
        text = re.sub(r"^\s*\d+[.)]\s*", "", text)
    return " ".join(text.split())


def stem_hash(row):
    return digest(normalized(row.get("text", ""), strip_number=True))


def quality(row):
    raw = row.get("options")
    options = raw if isinstance(raw, dict) else {}
    present = [x for x in LETTERS if isinstance(options.get(x), str) and options[x].strip()]
    values = [normalized(options[x]) for x in present]
    duplicate = len(values) != len(set(values))
    reasons = []
    if duplicate:
        reasons.append("duplicate_option_values")
    if raw and not isinstance(raw, dict):
        reasons.append("invalid_options_type")
    if any(x not in LETTERS or len(x) != 1 for x in options):
        reasons.append("unexpected_option_keys")
    text = str(row.get("text", "")) + " " + " ".join(str(v) for v in options.values())
    if "\ufffd" in text or any(x in text for x in ("Ã", "Â", "â€")):
        reasons.append("encoding_artifact")
    if any(re.search(r"\b[A-E]\s*[)\]]", str(v)) for v in options.values()):
        reasons.append("embedded_option_marker")
    if any(len(str(v)) > 160 for v in options.values()):
        reasons.append("unusually_long_option")
    if any(re.search(r"^\d+\s+\d+(?:\s|$)", str(v)) for v in options.values()):
        reasons.append("numeric_spacing_may_be_fraction_or_ocr")
    if any(re.search(r"[²³]\d|\d\s+\d*π", str(v)) for v in options.values()):
        reasons.append("suspicious_math_layout")
    figure_cue = bool(re.search(
        r"\b(figure|diagram|drawing|picture|shown|shaded|image|graph below)\b", text, re.I))
    image = "suspected" if row.get("text_only") is False or figure_cue else "unknown"
    if row.get("text_only") is True and not figure_cue:
        image = "not_indicated"
    return {"complete_options": len(present) == 5, "missing_options": len(present) < 5,
            "option_count": len(present), "duplicate_options": duplicate,
            "suspected_ocr_corruption": bool(reasons), "ocr_flags": reasons,
            "image_dependent": image, "figure_metadata": row.get("text_only") is False,
            "figure_text_cue": figure_cue}


TOPICS = (
    ("geometry", r"\b(triangle|square|rectangle|circle|cube|angle|area|perimeter|polygon|radius|diameter|parallel|rhombus|pentagon|hexagon|volume)\b"),
    ("probability", r"\b(probability|random|randomly|likely)\b"),
    ("number_theory", r"\b(prime|divisible|divisor|remainder|integer|digits?|multiple)\b"),
    ("combinatorics", r"\b(how many ways|arrange|arrangements|combinations|permutations|different paths)\b"),
    ("arithmetic", r"\b(percent|percentage|sum|difference|product|times|total|cost|euros?|candies|hours?|minutes?|average)\b|%"),
    ("algebra", r"\b(equation|expression|function|value of [xyz]|unknown)\b"),
    ("logic", r"\b(true|false|lies|truth|possible|impossible|at least|at most)\b"),
)


def topic(row):
    if row.get("topic"):
        return str(row["topic"]), "dataset_unverified"
    if row.get("language") != "eng":
        return "unknown", "no_language_rule"
    for name, pattern in TOPICS:
        if re.search(pattern, row.get("text", ""), re.I):
            return name, "english_keyword_v1_low_confidence"
    return "unknown", "unclassified"


def git(args, cwd):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   stderr=subprocess.DEVNULL).strip()


def source_info(root):
    root = Path(root).resolve()
    files = [root / x for x in ("predict.py", "eval.py", "build_index.py", "config.env")]
    files += sorted((root / "copilot").glob("*.py"))
    info = {"path": str(root), "files": {str(p.relative_to(root)): file_hash(p)
                                         for p in files if p.is_file()}}
    snapshot = root / "baseline-source.json"
    if snapshot.exists():
        spec = json.loads(snapshot.read_text(encoding="utf-8"))
        if spec["files"] != info["files"]:
            raise ValueError("Baseline snapshot changed since export")
        info["commit"] = spec["commit"]
        info["dirty"] = False
    else:
        try:
            info["commit"] = git(["rev-parse", "HEAD"], root)
            info["dirty"] = bool(git(["status", "--porcelain", "--untracked-files=normal"], root))
        except (OSError, subprocess.CalledProcessError):
            info.update(commit=None, dirty=None)
    info["digest"] = digest(info["files"])
    return info


def counts(rows, field):
    return dict(sorted(Counter(str(r.get(field, "unknown")) for r in rows).items()))
