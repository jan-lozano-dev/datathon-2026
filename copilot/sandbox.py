"""Run a short program written by the language model, with tight limits.

The program is checked first: only a few standard-library modules may be
imported, and nothing that reaches files, the network or the interpreter's
internals is allowed. Then it runs in its own Python process, without access
to the environment, with a CPU, memory and wall-clock limit.
"""
import ast
import os
import signal
import subprocess
import sys
import tempfile

try:
    import resource
except ImportError:  # not on Windows; the board and WSL have it
    resource = None

ALLOWED_MODULES = {"math", "itertools", "fractions", "collections", "functools", "datetime",
                   "decimal", "re", "string", "statistics"}
BANNED_NAMES = {"open", "exec", "eval", "compile", "__import__", "input", "globals", "locals",
                "getattr", "setattr", "delattr", "vars", "breakpoint", "exit", "quit", "help",
                "memoryview", "__builtins__"}
MAX_CODE_CHARS = 4000
MAX_OUTPUT_CHARS = 2000
MEMORY_BYTES = 512 * 1024 * 1024


def check(code):
    """Return None when the program may run, or a short reason when it may not."""
    if len(code) > MAX_CODE_CHARS:
        return "too long"
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, RecursionError):
        return "syntax"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.split(".")[0] not in ALLOWED_MODULES for alias in node.names):
                return "import"
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_MODULES:
                return "import"
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            return "name"
        elif isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            return "attribute"
    return None


def _limits(cpu_seconds):
    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    return apply


def run(code, timeout):
    """Run a checked program. Return (stdout, error): error is "" when it ended normally."""
    options = {}
    if resource is not None:
        options["preexec_fn"] = _limits(int(timeout) + 1)
        options["start_new_session"] = True
    try:
        process = subprocess.Popen([sys.executable, "-I", "-S", "-c", code], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   errors="replace", env={}, cwd=tempfile.gettempdir(), **options)
    except OSError as error:
        return "", f"spawn: {error}"
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            if resource is not None:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except OSError:
            pass
        process.communicate()
        return "", "timeout"
    if process.returncode != 0:
        last = (stderr.strip().splitlines() or ["exit %d" % process.returncode])[-1]
        return stdout[:MAX_OUTPUT_CHARS], "runtime: " + last[:120]
    return stdout[:MAX_OUTPUT_CHARS], ""
