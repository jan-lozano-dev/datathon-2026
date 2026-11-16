"""Run `python3 -m benchmark --help` from the repository root."""
import argparse
import csv
import html
import json
from pathlib import Path

from .common import key, keyed, read_jsonl, write_json
from .data import audit, check_index, prepare, snapshot
from .metrics import compare, load_results, markdown, summarize


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("snapshot", help="Export unchanged baseline source from Git")
    s.add_argument("--ref", default="366cf167982ab401b10b2a0ec5c71d622dea6074")
    s.add_argument("--repo", default=".")
    s.add_argument("--output", required=True)
    s = sub.add_parser("prepare", help="Freeze dev/final/full IDs and ordering")
    s.add_argument("--input", default="data/val.jsonl")
    s.add_argument("--output", required=True)
    s.add_argument("--dev-size", type=int, default=50)
    s.add_argument("--seed", type=int, default=42)
    s = sub.add_parser("audit", help="Dataset and split audit")
    s.add_argument("--train", default="data/train.jsonl")
    s.add_argument("--input", default="data/val.jsonl")
    s.add_argument("--output", required=True)
    s = sub.add_parser("check-index", help="Reject validation leakage in an existing index")
    s.add_argument("--train", default="data/train.jsonl")
    s.add_argument("--input", default="data/val.jsonl")
    s.add_argument("--index", default="data/index.db")
    s = sub.add_parser("run", help="Instrument an unchanged solver")
    s.add_argument("--input", default="data/val.jsonl")
    s.add_argument("--manifest", required=True)
    s.add_argument("--source", default=".")
    s.add_argument("--output", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--hardware", required=True, choices=["laptop", "arduino", "other"])
    s.add_argument("--cache-note", default="Existing service cache; no warm-up or reset by benchmark")
    s.add_argument("--rag", type=int, default=0)
    s.add_argument("--index", default="data/index.db")
    s.add_argument("--train", default="data/train.jsonl")
    s = sub.add_parser("report", help="Aggregate result metrics")
    s.add_argument("--run", required=True)
    s.add_argument("--reviews", help="Optional JSONL annotations joined by ID and language")
    s.add_argument("--output", required=True, help="JSON path; adjacent .md is also written")
    s = sub.add_parser("compare", help="Paired accuracy and latency comparison")
    s.add_argument("--left", required=True)
    s.add_argument("--right", required=True)
    s.add_argument("--output", required=True)
    s = sub.add_parser("inspect", help="PRIVATE local review packet; includes restricted text")
    s.add_argument("--run", required=True)
    s.add_argument("--input", default="data/val.jsonl")
    s.add_argument("--output", required=True, help="Must be under ignored results/")
    s.add_argument("--limit", type=int, default=30)
    args = p.parse_args()
    if args.command == "snapshot":
        result = snapshot(args.repo, args.ref, args.output)
    elif args.command == "prepare":
        result = prepare(args.input, args.output, args.dev_size, args.seed)
    elif args.command == "audit":
        result = audit(args.train, args.input)
        write_json(args.output, result)
    elif args.command == "check-index":
        result = check_index(args.index, args.train, args.input)
    elif args.command == "run":
        if args.rag < 0:
            p.error("--rag must be nonnegative")
        from .run import run
        result = run(args)
    elif args.command == "report":
        rows, meta = load_results(args.run)
        result = summarize(rows, read_jsonl(args.reviews) if args.reviews else [])
        result["provenance"] = {"hardware": meta["hardware"] if meta else "unknown (legacy file)",
                                "source": meta["source"] if meta else "unknown (legacy file)"}
        write_json(args.output, result)
        Path(args.output).with_suffix(".md").write_text(markdown(result), encoding="utf-8")
    elif args.command == "compare":
        result = compare(args.left, args.right)
        write_json(args.output, result)
    elif args.command == "inspect":
        out = Path(args.output).resolve()
        if Path("results").resolve() not in out.parents:
            p.error("Inspection packets contain restricted data and must stay under results/")
        out.mkdir(parents=True, exist_ok=False)
        rows, _ = load_results(args.run)
        data = keyed(read_jsonl(args.input))
        chosen = [r for r in rows if not r["correct"]][:args.limit]
        chosen += [r for r in rows if r["correct"]][:5]
        packet = [{"result": r, "problem": data[key(r)]} for r in chosen]
        write_json(out / "private-packet.json", packet)
        (out / "private-packet.html").write_text("<!doctype html><meta charset='utf-8'><title>PRIVATE error review</title>" +
            "<h1>PRIVATE local review — do not publish</h1>" + "".join(
                "<pre>" + html.escape(json.dumps(r, ensure_ascii=False, indent=2)) + "</pre><hr>" for r in packet), encoding="utf-8")
        with (out / "annotations-template.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["id", "language", "category", "confidence", "evidence", "reviewer"])
            for r in chosen:
                writer.writerow([*key(r), "unresolved", "unknown", "", ""])
        result = {"private_packet": str(out), "cases": len(chosen), "inspected": False}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
