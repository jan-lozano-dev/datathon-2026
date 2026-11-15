"""The copilot: one problem in, one letter out.

predict.py and eval.py both call solve(), so whatever is built here is exactly
what the official run measures.

With readable options, solve() first asks the model for a short program,
runs it, and answers with the option that equals its output (pot.py,
sandbox.py, options.py). When no single option matches, it falls back to
asking for one letter. Every step is planned against a time budget.
"""
import json
import os
import socket
import time
import urllib.error

from . import options as option_match
from . import pot, sandbox
from .config import CONFIG
from .llm import URL, answer_letter

TIME_LIMIT = float(CONFIG["TIME_LIMIT_SECONDS"])
FALLBACK = CONFIG["FALLBACK_ANSWER"]
MARGIN = 3.0  # seconds kept free for Python and for writing the answer
# The whole answer must be ready by BUDGET seconds, well inside TIME_LIMIT:
# the board slows down when it is warm or when something else uses the model.
BUDGET = float(os.environ.get("REASON_BUDGET_SECONDS", "50"))
EXEC_MAX = 6.0       # longest a program may run
EXEC_RESERVE = 2.0   # time kept for running the program when planning the request
LETTER_EXTRA = 1.5   # the letter request costs one more read of the problem, plus this
REPAIR = os.environ.get("REASON_REPAIR", "0") == "1"
# For experiments only: also ask for the letter when the program already answered,
# and write one JSON line per problem, so policies can be compared offline.
ALWAYS_LETTER = os.environ.get("REASON_ALWAYS_LETTER") == "1"
TRACE = os.environ.get("REASON_TRACE", "")


def _timed_out(error):
    return isinstance(error, (socket.timeout, TimeoutError)) or (
        isinstance(error, urllib.error.URLError) and isinstance(error.reason, (socket.timeout, TimeoutError)))


def _write_trace(problem, result, trace):
    if not TRACE:
        return
    row = {key: problem.get(key) for key in ("id", "language", "level", "text_only", "label", "options")}
    row.update({key: result.get(key) for key in ("answer", "method", "status", "seconds")})
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
    """Program first; one letter when the program gives no single option."""
    end = start + budget
    choices = problem["options"]
    read_seconds = None

    def after_first(seconds):  # the prompt has been read: now we know what a second request costs
        return end - (seconds + LETTER_EXTRA) - EXEC_RESERVE

    try:
        reply = pot.write_program(problem, llm_url, end - EXEC_RESERVE - LETTER_EXTRA, after_first)
        read_seconds = reply["read_seconds"]
        timings = reply["timings"]
        result["prompt_tokens"] = timings.get("prompt_n", 0)
        trace.update(program_reply=reply["text"], program_tokens=reply["tokens"], program_cut=reply["cut"],
                     program_read_seconds=read_seconds, program_prompt_n=timings.get("prompt_n"),
                     program_seconds=round(time.perf_counter() - start, 2))
        code = pot.extract_code(reply["text"])
        if REPAIR:
            code = pot.repair(code)
        problem_with_code = sandbox.check(code) if code.strip() else "empty"
        trace["program_check"] = problem_with_code or "ok"
        if problem_with_code is None:
            reserve = (read_seconds or 0.0) + LETTER_EXTRA
            allowed = min(EXEC_MAX, end - time.perf_counter() - reserve)
            if allowed >= 0.5:
                output, error = sandbox.run(code, allowed)
                trace.update(program_output=output[-300:], program_error=error)
                letter = option_match.match(output, choices)
                trace["program_letter"] = letter
                if letter:
                    result.update(answer=letter, method="pot")
    except (OSError, ValueError, KeyError) as error:  # the server failed or sent something unexpected
        trace["program_error"] = f"{type(error).__name__}: {error}"

    if result["method"] == "pot" and not ALWAYS_LETTER:
        return result
    needed = (read_seconds if read_seconds is not None else 10.0) + LETTER_EXTRA
    left = end - time.perf_counter()
    if left < needed and not ALWAYS_LETTER:
        result.update(method="prior", status="timeout")
        return result
    try:
        letter, scores, timings = pot.ask_letter(problem, llm_url, timeout=max(left, 1.0))
        trace.update(letter=letter, letter_scores=scores, letter_prompt_n=timings.get("prompt_n"))
        if result["method"] != "pot":
            result.update(answer=letter, method="letter")
    except (OSError, ValueError, KeyError, IndexError) as error:
        trace["letter_error"] = f"{type(error).__name__}: {error}"
        if result["method"] != "pot":
            result.update(method="prior", status="timeout" if _timed_out(error) else f"error: {error}")
    return result


def solve(problem, index=None, k=0, exclude_id=None, image_b64=None, llm_url=URL,
          time_limit=TIME_LIMIT):
    """Return {"answer", "seconds", "status", "method", ...} for one problem.

    index and k turn on retrieval, and image_b64 and llm_url send the problem
    image to a vision server: both use the original one-letter baseline.
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
