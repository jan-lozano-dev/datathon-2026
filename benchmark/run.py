"""Observe the existing solver without changing requests, prompts or decisions."""
import importlib
import json
import os
import platform
import sys
import time
import urllib.parse
from pathlib import Path

from .common import (digest, file_hash, inference_input, key, quality, source_info,
                     stamp, topic, write_json)
from .data import check_index, select


class Observer:
    """Transparent wrapper: same arguments, return object, and exceptions."""
    def __init__(self, post):
        self.post = post
        self.events = []

    def __call__(self, url, payload, timeout):
        host = urllib.parse.urlparse(url).hostname
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("Offline benchmark only permits loopback model servers")
        event = {"endpoint": url, "timeout_requested": timeout,
                 "request_sha256": digest(payload),
                 "parameters": {k: v for k, v in payload.items() if k not in ("messages", "input")},
                 "kind": "llm" if "messages" in payload else "embedding"}
        start = time.perf_counter()
        try:
            response = self.post(url, payload, timeout=timeout)
            # Malformed server replies must reach the original parser unchanged.
            # Telemetry must not introduce a new exception before that parser.
            if isinstance(response, dict):
                event["timings"] = response.get("timings") if isinstance(response.get("timings"), dict) else {}
                event["usage"] = response.get("usage") if isinstance(response.get("usage"), dict) else {}
                choices = response.get("choices")
                if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                    message = choices[0].get("message")
                    event["raw_output"] = message.get("content") if isinstance(message, dict) else None
                    event["finish_reason"] = choices[0].get("finish_reason")
            return response
        except Exception as error:
            event["exception"] = type(error).__name__
            raise
        finally:
            event["wall_seconds"] = time.perf_counter() - start
            self.events.append(event)


def host_info(hardware):
    device = Path("/proc/device-tree/model")
    device_name = device.read_bytes().rstrip(b"\0").decode(errors="replace") if device.exists() else None
    if hardware == "arduino" and platform.machine().lower() not in ("aarch64", "arm64"):
        raise ValueError("Cannot label non-ARM execution as Arduino")
    result = {"hardware_label": hardware, "platform": platform.platform(),
              "machine": platform.machine(), "python": sys.version, "device_model": device_name,
              "cpu_count": os.cpu_count(), "server_processes": []}
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            args = path.read_bytes().decode().rstrip("\0").split("\0")
            if args and Path(args[0]).name == "llama-server":
                result["server_processes"].append({"pid": int(path.parent.name), "argv": args,
                                                    "executable_sha256": file_hash(args[0])})
        except (OSError, UnicodeDecodeError):
            pass
    memory = Path("/proc/meminfo")
    result["memory_at_start"] = memory.read_text() if memory.exists() else None
    return result


def run(args):
    spec, problems = select(args.input, args.manifest)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)  # never overwrite/resume silently
    source = source_info(args.source)
    sys.path.insert(0, str(Path(args.source).resolve()))
    if "copilot" in sys.modules:
        raise ValueError("Run each experiment in a fresh Python process")
    config = importlib.import_module("copilot.config").CONFIG
    client = importlib.import_module("copilot.client")
    llm = importlib.import_module("copilot.llm")
    embed = importlib.import_module("copilot.embed")
    pipeline = importlib.import_module("copilot.pipeline")
    index = None
    index_audit = None
    if args.rag:
        index_audit = check_index(args.index, args.train, args.input)
        index = importlib.import_module("copilot.rag").Index(args.index)
    health = {}
    for name, port in (("llm", config["LLM_PORT"]), ("embed", config["EMBED_PORT"])):
        if name == "embed" and not args.rag:
            continue
        health[name] = client.get(f"http://127.0.0.1:{port}/health", timeout=5)
        if health[name].get("status") != "ok":
            raise ValueError(f"{name} server is not healthy")
    try:
        props = client.get(f"http://127.0.0.1:{config['LLM_PORT']}/props", timeout=5)
    except Exception as error:
        props = {"unavailable": type(error).__name__}
    model_path = Path(props.get("model_path", "__not_available__"))
    meta = {"schema": 1, "name": args.name, "started_utc": stamp(), "source": source,
            "manifest": spec, "hardware": host_info(args.hardware), "config": config,
            "health": health, "server_properties": props, "rag_k": args.rag,
            "index_audit": index_audit, "calibration_environment": os.environ.get("LETTER_CALIBRATION"),
            "model_sha256_actual": file_hash(model_path) if model_path.is_file() else None,
            "cache_policy": args.cache_note, "input_fields": ["id", "text", "options", "language"],
            "tooling_files": {p.name: file_hash(p) for p in Path(__file__).parent.glob("*.py")},
            "completed": False}
    write_json(output / "run.json", meta)
    observer = Observer(client.post)
    llm.post = observer
    embed.post = observer
    rows = []
    try:
        with (output / "predictions.jsonl").open("w", encoding="utf-8") as stream:
            for ordinal, problem in enumerate(problems):
                if problem.get("label") not in list("ABCDE"):
                    raise ValueError(f"Invalid/missing scoring label for {key(problem)}")
                observer.events = []
                start = time.perf_counter()
                exception = None
                try:
                    # Matches eval.py's exclude_id; scoring metadata never reaches solve().
                    result = pipeline.solve(inference_input(problem), index=index, k=args.rag,
                                            exclude_id=problem["id"])
                except Exception as error:
                    # Record a crash; do not manufacture a fallback or repair the output.
                    exception = type(error).__name__
                    result = {"answer": None, "status": "uncaught_exception"}
                wall = time.perf_counter() - start
                calls = [e for e in observer.events if e["kind"] == "llm"]
                event = calls[-1] if calls else {}
                usage, timings = event.get("usage", {}), event.get("timings", {})
                answer, status = result.get("answer"), result.get("status", "unknown")
                valid = isinstance(answer, str) and len(answer) == 1 and answer in "ABCDE"
                fallback = status == "timeout" or status.startswith("error:") or result.get("method") == "no_options_prior"
                topic_name, topic_source = topic(problem)
                row = {"ordinal": ordinal, "id": problem["id"], "language": problem.get("language", ""),
                       "difficulty": problem.get("level"), "difficulty_source": "school_level_proxy_not_item_difficulty",
                       "topic": topic_name, "topic_source": topic_source, "year": problem.get("year"),
                       "label": problem["label"], "answer": answer, "correct": answer == problem["label"],
                       **quality(problem), "status": status, "valid_output": valid, "fallback": fallback,
                       "exception": exception, "wall_seconds": wall, "solver_seconds": result.get("seconds"),
                       "over_limit": wall > float(config["TIME_LIMIT_SECONDS"]),
                       "prompt_tokens": usage.get("prompt_tokens"), "prompt_tokens_processed": timings.get("prompt_n"),
                       "prompt_tokens_cached": timings.get("cache_n"),
                       "generated_tokens": usage.get("completion_tokens", timings.get("predicted_n")),
                       "method": result.get("method", "llm"), "retrieved": result.get("retrieved", ""),
                       "calls": observer.events, "git_commit": source["commit"], "source_digest": source["digest"],
                       "manifest_sha256": spec["manifest_sha256"], "input_sha256": digest(inference_input(problem))}
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                rows.append(row)
                print(f"[{ordinal + 1}/{len(problems)}] {problem['id']} {status} {wall:.3f}s", flush=True)
        after = source_info(args.source)
        if after["digest"] != source["digest"]:
            raise ValueError("Source changed during run; reject this experiment")
        meta["completed"] = True
    finally:
        meta["finished_utc"] = stamp()
        meta["rows_completed"] = len(rows)
        write_json(output / "run.json", meta)
        with (output.parent / "experiments.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({k: meta[k] for k in ("name", "started_utc", "finished_utc", "completed", "rows_completed")} |
                                 {"run": str(output.resolve()), "commit": source["commit"],
                                  "source_digest": source["digest"], "manifest_sha256": spec["manifest_sha256"],
                                  "hardware": args.hardware}) + "\n")
    return {"rows": len(rows), "correct": sum(r["correct"] for r in rows), "output": str(output)}
