"""Program of thoughts: the model writes a short program and Python computes.

A 0.8B model is close to guessing when it must pick a letter in one token, but
it can often translate a counting or search problem into a brute-force loop.
The program's output is then compared with the options (see options.py).

Both requests share one prefix (SYSTEM and the worked EXAMPLES), and put what
they ask for at the end of the last user message. llama-server reuses the
prompt up to the last user message and reads the rest again, so the prefix is
read once, however long it is, and a second, different prefix would be read
on every request. Measured: 221 of 275 tokens reused with this layout.
"""
import ast
import http.client
import json
import os
import socket
import time
import urllib.parse

from .client import get, post
from .config import CONFIG

_SYSTEM = ("You solve multiple-choice math competition problems for school students, written in English "
           "or in Catalan. When asked for a program, write a short Python 3 program that finds the answer "
           "by brute force: loop over all the cases and count or search. {library}It must print only the "
           "final answer. No comments and no explanations.")
PROGRAM_TASK = "Python program that prints the answer:"
LETTER_TASK = "Letter of the correct option:"
MAX_PROGRAM_TOKENS = 160
FENCE = "`" * 3
LETTERS = "ABCDE"

# Worked examples, written for this project (they are not M3Kang or practice
# problems). They show the model the shape we want: no function, no comments,
# one print. Each is (statement, options, program, correct letter), and
# tests/test_reason.py runs every program against its letter.
ALL_EXAMPLES = [
    ("2. Five friends, Ada, Bru, Cai, Dan and Eva, sit in a row. Eva sits in the middle. "
     "Dan sits at the right end. Bru sits immediately to the left of Cai. Who sits at the left end?",
     ["Ada", "Bru", "Cai", "Dan", "Eva"],
     "from itertools import permutations\n"
     "for row in permutations([\"Ada\", \"Bru\", \"Cai\", \"Dan\", \"Eva\"]):\n"
     "    if row[2] == \"Eva\" and row[4] == \"Dan\" and row.index(\"Bru\") + 1 == row.index(\"Cai\"):\n"
     "        print(row[0])", "B"),
    ("8. A box contains 4 red balls and 3 green balls. Two balls are taken out at random. "
     "What is the probability that both are red?",
     ["1/49", "1/7", "4/21", "3/14", "2/7"],
     "from fractions import Fraction\nfrom itertools import combinations\n"
     "pairs = list(combinations(\"RRRRGGG\", 2))\n"
     "print(Fraction(sum(1 for p in pairs if p == (\"R\", \"R\")), len(pairs)))", "E"),
    ("6. Una pel·lícula comença a les 17:45 i dura 105 minuts. A quina hora acaba?",
     ["19:30", "19:35", "19:45", "20:15", "20:30"],
     "t = 17 * 60 + 45 + 105\nprint(f\"{t // 60}:{t % 60:02d}\")", "A"),
    ("9. Marta is 7 years older than her brother. The sum of their ages is 25. How old is Marta?",
     ["9", "16", "18", "21", "32"],
     "for brother in range(26):\n    marta = brother + 7\n    if brother + marta == 25:\n        print(marta)",
     "B"),
    ("11. En Joan té 15 monedes, totes de 10 o de 20 cèntims. En total té 210 cèntims. "
     "Quantes monedes de 20 cèntims té?",
     ["3", "4", "5", "6", "9"],
     "for b in range(16):\n    if 20 * b + 10 * (15 - b) == 210:\n        print(b)", "D"),
    ("4. How many three-digit numbers are multiples of 7 and end in the digit 3?",
     ["9", "12", "13", "14", "90"],
     "print(sum(1 for n in range(100, 1000) if n % 7 == 0 and n % 10 == 3))", "C"),
]
# The prefix that measured best differs by model, so it is chosen from the
# model the server has loaded (see configure()).
#   examples: which worked examples go in the prefix, in order.
#   library:  add a sentence that stops code models from importing sympy,
#             which the board does not have.
#   options:  show the options in the program request. Without them the
#             request is about 40% shorter to read; the letter request
#             always shows them.
# Measured on the 80 synthetic rows, program right:
#   default (Qwen3.5 0.8B): 29 with this example set, 23 and 24 with the
#   other two; 35 once the options are left out (50 tokens read per problem
#   instead of 80).
#   coder (Qwen2.5-Coder 1.5B): 43 with five or six examples; 47 once the
#   options are left out (42 tokens instead of 72).
# Both models do better when they compute first and are not shown the
# distractors.
PROFILES = {
    "default": {"examples": (5, 4, 1, 0, 2), "library": False, "options": False},
    "coder": {"examples": (0, 1, 2, 3, 4, 5), "library": True, "options": False},
}
PROFILE = "default"
SYSTEM = ""
EXAMPLES = []
PROGRAM_SEES_OPTIONS = True


def use_profile(name):
    """Set the shared prefix. Environment variables override it, for experiments."""
    global PROFILE, SYSTEM, EXAMPLES, PROGRAM_SEES_OPTIONS
    PROFILE = name
    profile = PROFILES[name]
    chosen = os.environ.get("REASON_EXAMPLES")
    indexes = [int(i) for i in chosen.split(",") if i] if chosen is not None else profile["examples"]
    library = os.environ.get("REASON_LIBRARY", "1" if profile["library"] else "0") == "1"
    EXAMPLES = [ALL_EXAMPLES[i] for i in indexes]
    SYSTEM = _SYSTEM.format(library="Use only the Python standard library. " if library else "")
    PROGRAM_SEES_OPTIONS = os.environ.get("REASON_POT_OPTIONS", "1" if profile["options"] else "0") == "1"


def configure(url):
    """Pick the profile for the model behind url. Returns the model's file name, or "" if unknown."""
    parts = urllib.parse.urlsplit(url)
    try:
        path = get(f"{parts.scheme}://{parts.netloc}/props").get("model_path") or ""
    except (OSError, ValueError):
        path = ""
    name = os.path.basename(path)
    use_profile(os.environ.get("REASON_PROFILE") or ("coder" if "coder" in name.lower() else "default"))
    return name


use_profile(os.environ.get("REASON_PROFILE", "default"))


def statement(problem, with_options=True):
    lines = [problem["text"].strip()]
    options = (problem.get("options") or {}) if with_options else {}
    lines += [f"{letter}) {options[letter]}" for letter in LETTERS if letter in options]
    return "\n".join(lines)


def _prefix():
    messages = [{"role": "system", "content": SYSTEM}]
    for text, choices, program, _letter in EXAMPLES:
        example = {"text": text, "options": dict(zip(LETTERS, choices))}
        messages.append({"role": "user",
                         "content": statement(example, PROGRAM_SEES_OPTIONS) + "\n\n" + PROGRAM_TASK})
        messages.append({"role": "assistant", "content": f"{FENCE}python\n{program}\n{FENCE}"})
    return messages


def _messages(problem, task):
    with_options = PROGRAM_SEES_OPTIONS or task != PROGRAM_TASK
    return _prefix() + [{"role": "user", "content": statement(problem, with_options) + "\n\n" + task}]


def warm_up(url, timeout=600):
    """Make the server read the shared prefix once, before any problem is timed.

    Call configure(url) first, so the prefix is the one for the loaded model.
    Returns the prompt tokens it had to read (a handful when the prefix was
    already cached), or None when the server did not answer: solve() works
    either way, the first problem just pays for the reading.
    """
    payload = {"messages": _prefix() + [{"role": "user", "content": "Ready?"}], "max_tokens": 1,
               "temperature": 0, "seed": int(CONFIG["SEED"]), "cache_prompt": True}
    try:
        return post(url, payload, timeout=timeout).get("timings", {}).get("prompt_n", 0)
    except (OSError, ValueError):
        return None


def stream_chat(url, payload, stop_at, after_first=None, done=None):
    """Send a chat request and read the answer as it is written.

    Reading stops at stop_at (a time.perf_counter() value), and closing the
    connection makes the server stop writing. after_first(out) is called when
    the first token arrives, with out["read_seconds"] (the time the server
    took to read the prompt) and out["timings"], and may return an earlier
    stop time. done(text) returns True when the answer is complete.
    """
    parts = urllib.parse.urlsplit(url)
    started = time.perf_counter()
    out = {"text": "", "tokens": 0, "read_seconds": None, "cut": "", "timings": {}}
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80,
                                            timeout=max(stop_at - started, 0.5))
    response = None
    try:
        connection.request("POST", parts.path, body=json.dumps(dict(payload, stream=True)).encode(),
                           headers={"Content-Type": "application/json"})
        sock = connection.sock
        response = connection.getresponse()
        if response.status != 200:
            raise OSError(f"HTTP {response.status}")
        while True:
            left = stop_at - time.perf_counter()
            if left <= 0:
                out["cut"] = "deadline"
                break
            try:
                sock.settimeout(left)
            except OSError:
                pass
            raw = response.readline()
            if not raw:  # the server closed the stream
                break
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            chunk = json.loads(data)
            if chunk.get("timings"):
                out["timings"] = chunk["timings"]
            choices = chunk.get("choices") or [{}]
            piece = (choices[0].get("delta") or {}).get("content")
            if piece:
                if out["read_seconds"] is None:
                    out["read_seconds"] = time.perf_counter() - started
                    if after_first:
                        stop_at = min(stop_at, after_first(out))
                out["text"] += piece
                out["tokens"] += 1
                if done and done(out["text"]):
                    out["cut"] = "complete"
                    break
    except (socket.timeout, TimeoutError):
        out["cut"] = "deadline"
    finally:
        if response is not None:
            response.close()
        connection.close()
    return out


def _code_complete(text):
    return text.count(FENCE) >= 2


def write_program(problem, url, stop_at, after_first=None):
    payload = {"messages": _messages(problem, PROGRAM_TASK), "max_tokens": MAX_PROGRAM_TOKENS,
               "temperature": 0, "seed": int(CONFIG["SEED"]), "cache_prompt": True,
               "timings_per_token": True}  # so prompt_n is known even when we stop reading early
    return stream_chat(url, payload, stop_at, after_first=after_first, done=_code_complete)


def ask_letter(problem, url, timeout, top_logprobs=512):
    """One token, A to E. Return (letter, {letter: logprob}, timings)."""
    payload = {"messages": _messages(problem, LETTER_TASK), "grammar": "root ::= [A-E]",
               "max_tokens": 1, "temperature": 0, "seed": int(CONFIG["SEED"]), "cache_prompt": True,
               "logprobs": True, "top_logprobs": top_logprobs}
    response = post(url, payload, timeout=timeout)
    choice = response["choices"][0]
    letter = choice["message"]["content"].strip()
    entries = (choice.get("logprobs") or {}).get("content") or []
    top = entries[0].get("top_logprobs", []) if entries else []
    scores = {item["token"]: item["logprob"] for item in top
              if item.get("token") in tuple(LETTERS) and "logprob" in item}
    return letter, scores, response.get("timings", {})


def extract_code(text):
    """Take the program out of the model's reply, with or without a code fence."""
    if FENCE in text:
        body = text.split(FENCE, 1)[1].split(FENCE, 1)[0]
        first, newline, rest = body.partition("\n")
        if newline and first.strip().lower() in ("python", "python3", "py", ""):
            body = rest
        text = body
    return text.strip("\n")


def _parse(code):
    try:
        return ast.parse(code)
    except (SyntaxError, ValueError, RecursionError):
        return None


def _no_arguments(function):
    arguments = function.args
    required = len(arguments.posonlyargs) + len(arguments.args) - len(arguments.defaults)
    missing_keywords = sum(default is None for default in arguments.kw_defaults)
    return required == 0 and missing_keywords == 0


def _prints(node):
    return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "print"
               for n in ast.walk(node))


def repair(code):
    """Fix the two slips the model makes most: a cut last line, and a result that is never printed."""
    tree = _parse(code)
    lines = code.split("\n")
    for _ in range(4):  # the reply was cut off: drop unfinished lines at the end
        if tree is not None or len(lines) <= 1:
            break
        lines.pop()
        tree = _parse("\n".join(lines))
    if tree is None or not tree.body:
        return code
    code = "\n".join(lines)
    runs = [node for node in tree.body
            if not isinstance(node, (ast.FunctionDef, ast.Import, ast.ImportFrom, ast.ClassDef))]
    last = tree.body[-1]
    if _prints(ast.Module(body=runs, type_ignores=[])):
        return code
    if isinstance(last, ast.Expr):
        if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and any(isinstance(f, ast.FunctionDef) and f.name == n.func.id and _prints(f)
                       for f in tree.body) for n in ast.walk(last)):
            return code  # the function it calls prints the answer itself
        tree.body[-1] = ast.Expr(ast.Call(ast.Name("print", ast.Load()), [last.value], []))
        return ast.unparse(ast.fix_missing_locations(tree))
    if isinstance(last, ast.Assign) and len(last.targets) == 1 and isinstance(last.targets[0], ast.Name):
        return code + f"\nprint({last.targets[0].id})"
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and _no_arguments(node)]
    if functions and not runs:  # only definitions: nothing was ever called
        name = functions[-1].name
        return code + (f"\n{name}()" if _prints(functions[-1]) else f"\nprint({name}())")
    return code
