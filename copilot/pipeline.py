"""The copilot: one problem in, one letter out.

predict.py and eval.py both call solve(), so whatever is built here is exactly
what the official run measures.

With readable options, solve() asks the model for a short program, runs it,
and answers with the option that equals its output (pot.py, sandbox.py,
options.py). When the program gives no option, the answer is FALLBACK_ANSWER
at once. Asking the model for a letter instead was measured and dropped:
over 17 runs with four models it was right 173 times out of 784 (22%, with
guessing at 20%), and on the board it cost about ten seconds per problem,
which the program can use.
"""
import json
import os
import socket
import sys
import time
import urllib.error

from . import options as option_match
from . import pot, sandbox
from .config import CONFIG
from .llm import URL, answer_letter

# Reason can use its own model server, so that the model the teaching side
# talks to stays as it is. Empty means the usual one, on LLM_PORT.
if CONFIG.get("REASON_LLM_PORT"):
    URL = f"http://127.0.0.1:{CONFIG['REASON_LLM_PORT']}/v1/chat/completions"

TIME_LIMIT = float(CONFIG["TIME_LIMIT_SECONDS"])
FALLBACK = CONFIG["FALLBACK_ANSWER"]
MARGIN = 3.0  # seconds kept free for Python and for writing the answer
# The whole answer must be ready by BUDGET seconds, inside TIME_LIMIT. Our own
# clock makes the cut (the model is stopped at BUDGET - EXEC_RESERVE and the
# program at BUDGET), so a slow board loses programs, not the deadline. The 5 s
# left over are for what that clock cannot stop: Python itself stalling.
# Raised from 50: with the 1.5B model the board cuts many programs short
# (simulated on the practice set at 3.0/1.5 tok/s: 41 -> 43 right out of 100).
BUDGET = float(os.environ.get("REASON_BUDGET_SECONDS", "55"))
EXEC_MAX = 6.0      # longest a program may run
EXEC_RESERVE = 2.0  # time kept for running the program: the model must stop writing this early
REPAIR = os.environ.get("REASON_REPAIR", "1") == "1"
# For experiments only. TRACE writes one JSON line per problem, so policies can
# be compared offline with experiments/replay.py. ALWAYS_LETTER also records
# the letter the model would pick, without using it.
TRACE = os.environ.get("REASON_TRACE", "")
ALWAYS_LETTER = os.environ.get("REASON_ALWAYS_LETTER") == "1"


def _start():
    """Choose the prefix for the loaded model and make the server read it once.

    The shared prefix (instructions and worked examples) is long. Reading it
    here, when predict.py starts, keeps that cost out of every problem's clock.
    """
    model = pot.configure(URL)
    if os.environ.get("REASON_WARMUP", "1") != "1":
        return model, None
    print(f"Reason: {model or 'unknown model'}, {pot.PROFILE} profile. "
          "Reading the shared prompt once, before the first problem...", file=sys.stderr, flush=True)
    started = time.perf_counter()
    read = pot.warm_up(URL)
    note = "the server did not answer" if read is None else f"{read} tokens in {time.perf_counter() - started:.0f} s"
    print(f"Reason: ready ({note}).", file=sys.stderr, flush=True)
    return model, read


MODEL, WARMED = _start()


def _timed_out(error):
    return isinstance(error, (socket.timeout, TimeoutError)) or (
        isinstance(error, urllib.error.URLError) and isinstance(error.reason, (socket.timeout, TimeoutError)))


def _write_trace(problem, result, trace):
    if not TRACE:
        return
    row = {key: problem.get(key) for key in ("id", "language", "level", "text_only", "label", "options")}
    row.update({key: result.get(key) for key in ("answer", "method", "status", "seconds")})
    row.update(program_sees_options=pot.PROGRAM_SEES_OPTIONS, profile=pot.PROFILE, model=MODEL)
    row.update(trace)
    with open(TRACE, "a", encoding="utf-8") as out:
        out.write(json.dumps(row, ensure_ascii=False) + "\n")


def _legacy(problem, index, k, exclude_id, image_b64, llm_url, time_limit, start, result):
    """The original baseline: one letter, optionally with retrieved examples or an image."""
    try:
        examples = []
        if index is not None and k > 0:
            hits = index.search(problem, k=k, exclude_id=exclude_id)
            examples = [p for _score, p in hits]
            result["examples"] = hits
            result["retrieved"] = ";".join(f"{p['id']}:{s:.2f}" for s, p in hits)
        remaining = time_limit - (time.perf_counter() - start) - MARGIN
        letter, timings = answer_letter(problem, examples, timeout=max(remaining, 1.0),
                                        image_b64=image_b64, url=llm_url)
        result["answer"] = letter
        result["prompt_tokens"] = timings.get("prompt_n", 0)
    except (socket.timeout, TimeoutError):
        result["status"] = "timeout"
    except urllib.error.URLError as error:
        result["status"] = "timeout" if _timed_out(error) else f"error: {error.reason}"
    return result


def _reason(problem, llm_url, budget, start, result, trace):
    """Ask for a program, run it, and answer with the option its output points to."""
    end = start + budget
    choices = problem["options"]
    try:
        reply = pot.write_program(problem, llm_url, end - EXEC_RESERVE)
        timings = reply["timings"]
        result["prompt_tokens"] = timings.get("prompt_n", 0)
        trace.update(program_reply=reply["text"], program_tokens=reply["tokens"], program_cut=reply["cut"],
                     program_read_seconds=reply["read_seconds"], program_prompt_n=timings.get("prompt_n"),
                     program_seconds=round(time.perf_counter() - start, 2))
        if reply["cut"] == "deadline":
            result["status"] = "timeout"  # unless what was written already runs and answers
        code = pot.extract_code(reply["text"])
        if REPAIR:
            code = pot.repair(code)
        refused = sandbox.check(code) if code.strip() else "empty"
        trace["program_check"] = refused or "ok"
        allowed = min(EXEC_MAX, end - time.perf_counter())
        if refused is None and allowed >= 0.5:
            ran = time.perf_counter()
            output, error = sandbox.run(code, allowed)
            letter = option_match.match(output, choices)
            near = None if letter else option_match.nearest(output, choices)
            trace.update(program_output=output[-300:], program_error=error, program_letter=letter,
                         program_near=near, program_run_seconds=round(time.perf_counter() - ran, 3))
            if letter or near:
                result.update(answer=letter or near, method="pot" if letter else "near", status="ok")
    except (OSError, ValueError, KeyError) as error:  # the server failed or sent something unexpected
        trace["program_error"] = f"{type(error).__name__}: {error}"
        result["status"] = "timeout" if _timed_out(error) else f"error: {error}"

    if ALWAYS_LETTER:
        try:
            letter, scores, _timings = pot.ask_letter(problem, llm_url, timeout=60)
            trace.update(letter=letter, letter_scores=scores)
        except (OSError, ValueError, KeyError, IndexError) as error:
            trace["letter_error"] = f"{type(error).__name__}: {error}"
    return result


def solve(problem, index=None, k=0, exclude_id=None, image_b64=None, llm_url=URL,
          time_limit=TIME_LIMIT):
    """Return {"answer", "seconds", "status", "method", ...} for one problem.

    method says where the answer came from: "pot" (the program's output equals
    one option), "near" (it is a number between the options: the closest one),
    "prior" (FALLBACK_ANSWER, because the program gave nothing), or
    "no_options_prior". index and k turn on retrieval, and image_b64 and
    llm_url send the problem image to a vision server: both use the original
    one-letter baseline, method "llm".
    """
    start = time.perf_counter()
    result = {"answer": FALLBACK, "status": "ok", "prompt_tokens": 0,
              "retrieved": "", "examples": [], "method": "llm"}
    trace = {}
    if not problem.get("options") and image_b64 is None:
        # Without readable choices, no value can be mapped to A-E, and the
        # training split favors the fixed prior over asking the model to guess.
        result["method"] = "no_options_prior"
    elif image_b64 is not None or (index is not None and k > 0):
        _legacy(problem, index, k, exclude_id, image_b64, llm_url, time_limit, start, result)
    else:
        result["method"] = "prior"
        _reason(problem, llm_url, min(BUDGET, time_limit - MARGIN), start, result, trace)
    result["seconds"] = round(time.perf_counter() - start, 2)
    _write_trace(problem, result, trace)
    return result
