"""Letter-prior calibration, using no dependencies beyond the standard library."""
import hashlib
import json
import math
import os

from .config import CONFIG, ROOT

LETTERS = "ABCDE"
DEFAULT_PATH = os.path.join(ROOT, "data", "letter_prior.json")


def prompt_fingerprint():
    """Invalidate the prior when the model or prompt implementation changes."""
    from . import llm
    with open(llm.__file__, "rb") as source:
        prompt_hash = hashlib.sha256(source.read()).hexdigest()
    return {"llm_file_sha256": prompt_hash, "model_sha256": CONFIG["LLM_SHA256"]}


def normalize_scores(scores):
    """Softmax conditional on the five answer letters."""
    if set(scores) != set(LETTERS):
        return None
    top = max(scores.values())
    weights = {letter: math.exp(scores[letter] - top) for letter in LETTERS}
    total = sum(weights.values())
    return {letter: weights[letter] / total for letter in LETTERS}


def load_prior(path=DEFAULT_PATH):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as source:
        data = json.load(source)
    if data.get("fingerprint") != prompt_fingerprint():
        raise ValueError("letter prior is stale; rerun calibrate_letters.py")
    prior = data["prior"]
    if set(prior) != set(LETTERS) or any(not 0 < prior[l] < 1 for l in LETTERS):
        raise ValueError("invalid letter prior")
    return prior


def choose(scores, prior):
    """Divide each letter's likelihood by its estimated prior."""
    if set(scores) != set(LETTERS):
        return None
    return max(LETTERS, key=lambda letter: scores[letter] - math.log(prior[letter]))
