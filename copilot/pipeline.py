"""The baseline copilot: one problem in, one letter out.

This is the file to change first. predict.py and eval.py both call solve(),
so whatever you build here is exactly what the official run measures.
"""
import os
import socket
import time
import urllib.error

from .config import CONFIG
from .llm import URL, answer_letter
from .calibration import load_prior, choose

TIME_LIMIT = float(CONFIG["TIME_LIMIT_SECONDS"])
FALLBACK = CONFIG["FALLBACK_ANSWER"]
MARGIN = 3.0  # seconds kept free for Python and for writing the answer
# Enable only after measuring a gain on this model and prompt. A prior is
# generated locally from training data by calibrate_letters.py.
CALIBRATION_ENABLED = os.environ.get("LETTER_CALIBRATION") == "1"
PRIOR = load_prior() if CALIBRATION_ENABLED else None
if CALIBRATION_ENABLED and PRIOR is None:
    raise RuntimeError("LETTER_CALIBRATION=1 needs data/letter_prior.json; run calibrate_letters.py")


def solve(problem, index=None, k=0, exclude_id=None, image_b64=None, llm_url=URL,
          time_limit=TIME_LIMIT):
    """Return {"answer", "seconds", "status", ...} for one problem.

    index and k turn on retrieval: the k most similar solved problems are
    added to the prompt as examples. Each example costs reading time.
    image_b64 and llm_url send the problem image to a vision server.
    """
    start = time.perf_counter()
    result = {"answer": FALLBACK, "status": "ok", "prompt_tokens": 0,
              "retrieved": "", "examples": [], "method": "llm"}
    if not problem.get("options") and image_b64 is None:
        # Without readable choices, the text model cannot map a value to A-E.
        # The training split favors the fixed prior over asking it to guess.
        result["method"] = "no_options_prior"
        result["seconds"] = round(time.perf_counter() - start, 2)
        return result
    try:
        examples = []
        if index is not None and k > 0:
            hits = index.search(problem, k=k, exclude_id=exclude_id)
            examples = [p for _score, p in hits]
            result["examples"] = hits
            result["retrieved"] = ";".join(f"{p['id']}:{s:.2f}" for s, p in hits)
        remaining = time_limit - (time.perf_counter() - start) - MARGIN
        use_prior = PRIOR is not None and bool(problem.get("options")) and not image_b64
        response = answer_letter(problem, examples, timeout=max(remaining, 1.0),
                                 image_b64=image_b64, url=llm_url, with_scores=use_prior)
        if use_prior:
            letter, timings, scores = response
            calibrated = choose(scores, PRIOR)
            result["answer"] = calibrated or letter
            if calibrated is None:
                result["status"] = "missing_letter_scores"
        else:
            letter, timings = response
            result["answer"] = letter
        result["prompt_tokens"] = timings.get("prompt_n", 0)
    except (socket.timeout, TimeoutError):
        result["status"] = "timeout"
    except urllib.error.URLError as error:
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            result["status"] = "timeout"
        else:
            result["status"] = f"error: {error.reason}"
    result["seconds"] = round(time.perf_counter() - start, 2)
    return result
