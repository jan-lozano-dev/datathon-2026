"""LearnHarness <-> adaptive trainer bridge.

One JSON request on stdin, one JSON reply on stdout. Standard library only.

The selection rules and the level estimate live in the team's trainer
(copilot/teach/trainer.py). This file imports it without changing it and adds
only what the web practice needs around it:

- a session per student: the language and the problem being shown now, so a
  reload resumes the same problem and a stale or repeated submit is refused;
- the confidence of each answer, stored next to the attempt in the same
  transaction (table lh_attempts, keyed by the trainer's attempts.n);
- skipping a problem whose required image is missing, without recording an
  attempt (table lh_skips), so it never moves the level estimate;
- a static, hand-written explanation per problem, returned only in the result
  of an answer (never before), so showing it needs no model.

The level estimate is the trainer's estimate_level over (level, right?) only:
confidence is stored but does not enter the formula.

Configuration (environment, all required; the Next server sets them):
    LH_TRAINER_PY   path to copilot/teach/trainer.py
    LH_BANK         JSONL problem files, separated by os.pathsep
    LH_IMAGES       directory with <id>_<language>.png images
    LH_PRACTICE_DB  SQLite file for profiles, attempts and sessions
    LH_EXPLANATIONS optional JSON {problem id: text, or {language: text}}

Requests: {"op": "profiles"} | {"op": "state", "student": ...}
    | {"op": "start", "student": ..., "language": ...}
    | {"op": "answer", "student", "key", "letter", "confidence", "submission_id"}
    | {"op": "skip", "student", "key", "submission_id"}
Replies: {"ok": true, ...} or {"ok": false, "error": {"code", "message"}}.
"""
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time

LETTERS = "ABCDE"
STUDENT_ID = re.compile(r"^[^\x00-\x1f]{1,40}$")
SUBMISSION_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
PROBLEM_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
LANGUAGE = re.compile(r"^[a-z]{2,8}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS lh_sessions (
    student_id  TEXT PRIMARY KEY,
    language    TEXT NOT NULL,
    current_key TEXT,
    started     REAL NOT NULL,
    updated     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS lh_attempts (
    attempt_n     INTEGER PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    confidence    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lh_skips (
    n             INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    TEXT NOT NULL,
    problem_key   TEXT NOT NULL,
    problem_id    TEXT NOT NULL,
    reason        TEXT NOT NULL,
    submission_id TEXT NOT NULL UNIQUE,
    ts            REAL NOT NULL
);
"""


class BridgeError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.message, self.extra = code, message, extra


def load_trainer(path):
    if not path or not os.path.isfile(path):
        raise BridgeError("unavailable", f"Trainer not found: {path!r} (set LH_TRAINER_PY)")
    spec = importlib.util.spec_from_file_location("lh_m3kang_trainer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def image_file(images_dir, problem):
    """The image path for a problem, only inside images_dir and only for safe names."""
    pid, language = str(problem.get("id", "")), str(problem.get("language", ""))
    if not images_dir or not PROBLEM_ID.match(pid) or not LANGUAGE.match(language):
        return None
    root = os.path.realpath(images_dir)
    path = os.path.realpath(os.path.join(root, f"{pid}_{language}.png"))
    if os.path.dirname(path) != root or not os.path.isfile(path):
        return None
    return path


def has_text_options(problem):
    options = problem.get("options") or {}
    return all(isinstance(options.get(x), str) and options.get(x).strip() for x in LETTERS)


def playable(problem):
    """A letter answer, and either five text options or options to read in the image.

    The trainer's own is_playable needs five text options; here a problem
    whose options are pictures stays in the bank and is answered by letter.
    """
    return problem.get("label") in tuple(LETTERS)


class Bridge:
    def __init__(self, trainer_py, bank_paths, images_dir, db_path, explanations_path=""):
        self.T = load_trainer(trainer_py)
        self.explanations = load_explanations(explanations_path)
        self.images_dir = images_dir
        self.problems = self.T.load_jsonl(*bank_paths)
        if not self.problems:
            raise BridgeError("unavailable", "The problem bank is empty or missing (set LH_BANK)")
        self.banks = {}
        if not db_path:
            raise BridgeError("unavailable", "No practice database configured (set LH_PRACTICE_DB)")
        if db_path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        # The trainer's Profile creates its tables; we then drive transactions explicitly
        self.profile = self.T.Profile(db_path)
        self.db = self.profile.db
        self.db.isolation_level = None
        self.db.execute("PRAGMA busy_timeout = 10000")
        self.db.executescript(SCHEMA)

    # --- bank and problem views -------------------------------------------------

    def languages(self):
        counts = {}
        for p in self.problems:
            if playable(p):
                counts[p.get("language")] = counts.get(p.get("language"), 0) + 1
        return counts

    def bank(self, language):
        if language not in self.banks:
            self.banks[language] = self.T.Bank(self.problems, language=language, playable=playable)
        return self.banks[language]

    def view(self, problem):
        """What the browser may see: the trainer's public view plus the image facts."""
        if problem is None:
            return None
        data = self.T.public(problem)
        data.pop("label", None)
        text_options = has_text_options(problem)
        if not text_options:
            data["options"] = {}
        image = image_file(self.images_dir, problem)
        required = not problem.get("text_only", True) or not text_options
        data.update({
            "options_in_image": not text_options,
            "image_required": required,
            "image": bool(image),
            "image_missing": required and not image,
        })
        return data

    def explanation(self, problem):
        """The explanation for this problem, in its language when available."""
        entry = self.explanations.get(str(problem.get("id")))
        if isinstance(entry, dict):
            entry = entry.get(problem.get("language")) or entry.get("eng") or next(iter(entry.values()), None)
        return entry if isinstance(entry, str) and entry.strip() else None

    # --- session state ------------------------------------------------------------

    def session(self, student):
        row = self.db.execute("SELECT * FROM lh_sessions WHERE student_id = ?", (student,)).fetchone()
        return dict(row) if row else None

    def choose_next(self, student, bank):
        """The trainer's rule (as in Trainer.start), with skipped problems also counted as seen."""
        attempts = self.db.execute(
            "SELECT problem_key, problem_id, correct FROM attempts WHERE student_id = ? ORDER BY n",
            (student,)).fetchall()
        seen = {r["problem_id"] for r in attempts}
        seen |= {r[0] for r in self.db.execute("SELECT problem_id FROM lh_skips WHERE student_id = ?", (student,))}
        if attempts:
            last = bank.by_key.get(attempts[-1]["problem_key"])
            if last is not None:
                return self.T.next_problem(bank, last, bool(attempts[-1]["correct"]), seen)
        level = self.db.execute("SELECT level_est FROM students WHERE student_id = ?", (student,)).fetchone()[0]
        return self.T.first_problem(bank, level, seen)

    def state(self, student):
        session = self.session(student)
        if session is None:
            return {"student": None, "problem": None, "done": False}
        bank = self.bank(session["language"])
        problem = bank.by_key.get(session["current_key"]) if session["current_key"] else None
        summary = self.profile.summary(student)
        summary["by_level"] = {str(k): v for k, v in summary["by_level"].items()}
        summary["skipped"] = self.db.execute(
            "SELECT COUNT(*) FROM lh_skips WHERE student_id = ?", (student,)).fetchone()[0]
        summary["language"] = session["language"]
        summary["bank_size"] = len(bank)
        summary["bank_levels"] = bank.levels
        return {"student": summary, "problem": self.view(problem), "done": problem is None}

    def _repair_current(self, student):
        """If the shown problem left the bank (data changed), pick a new one."""
        session = self.session(student)
        if session and session["current_key"] and session["current_key"] not in self.bank(session["language"]).by_key:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                upcoming = self.choose_next(student, self.bank(session["language"]))
                self._set_current(student, upcoming)
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def _set_current(self, student, problem):
        self.db.execute("UPDATE lh_sessions SET current_key = ?, updated = ? WHERE student_id = ?",
                        (self.T.problem_key(problem) if problem else None, time.time(), student))

    # --- operations -------------------------------------------------------------------

    def op_profiles(self, _request):
        rows = self.db.execute(
            "SELECT s.student_id, s.language, s.updated, st.level_est,"
            " (SELECT COUNT(*) FROM attempts a WHERE a.student_id = s.student_id) AS answered,"
            " (SELECT COALESCE(SUM(correct), 0) FROM attempts a WHERE a.student_id = s.student_id) AS n_right"
            " FROM lh_sessions s JOIN students st ON st.student_id = s.student_id ORDER BY s.updated DESC")
        profiles = [{"student_id": r["student_id"], "language": r["language"], "answered": r["answered"],
                     "right": r["n_right"], "level": int(self.T.clamp_level(r["level_est"]) + 0.5),
                     "updated": r["updated"]} for r in rows]
        return {"profiles": profiles, "languages": self.languages()}

    def op_state(self, request):
        student = student_id(request)
        self._repair_current(student)
        return self.state(student)

    def op_start(self, request):
        student = student_id(request)
        language = request.get("language")
        if not isinstance(language, str) or language not in self.languages():
            raise BridgeError("bad_request", "Unknown or empty language for this bank")
        if self.session(student) is None:
            try:
                self.profile.student(student)  # the trainer's row: start level and prior
            except sqlite3.IntegrityError:
                pass  # created at the same moment by a concurrent request
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if self.session(student) is None:  # another request may have won the race
                    now = time.time()
                    self.db.execute("INSERT INTO lh_sessions VALUES (?, ?, NULL, ?, ?)", (student, language, now, now))
                    self._set_current(student, self.choose_next(student, self.bank(language)))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
        self._repair_current(student)
        return self.state(student)

    def _replay(self, student, submission):
        """The stored outcome of a submission already processed, or None."""
        row = self.db.execute(
            "SELECT a.*, m.confidence FROM lh_attempts m JOIN attempts a ON a.n = m.attempt_n"
            " WHERE m.submission_id = ?", (submission,)).fetchone()
        if row is not None:
            if row["student_id"] != student:
                raise BridgeError("conflict", "This submission belongs to another session")
            session = self.session(student)
            problem = self.bank(session["language"]).by_key.get(row["problem_key"]) if session else None
            return {"result": {"kind": "answer", "key": row["problem_key"], "correct": bool(row["correct"]),
                               "letter": row["answer"], "confidence": row["confidence"],
                               "explanation": self.explanation(problem) if problem else None}, "replayed": True}
        row = self.db.execute("SELECT * FROM lh_skips WHERE submission_id = ?", (submission,)).fetchone()
        if row is not None:
            if row["student_id"] != student:
                raise BridgeError("conflict", "This submission belongs to another session")
            return {"result": {"kind": "skip", "key": row["problem_key"]}, "replayed": True}
        return None

    def _begin_submission(self, request):
        """Validate, lock, and either replay a known submission or return the shown problem."""
        student = student_id(request)
        submission = request.get("submission_id")
        if not isinstance(submission, str) or not SUBMISSION_ID.match(submission):
            raise BridgeError("bad_request", "Missing or invalid submission_id")
        key = request.get("key")
        if not isinstance(key, str):
            raise BridgeError("bad_request", "Missing problem key")
        self.db.execute("BEGIN IMMEDIATE")
        replay = self._replay(student, submission)
        if replay is not None:
            return student, submission, None, replay
        session = self.session(student)
        if session is None:
            raise BridgeError("not_found", "No session for this student")
        if session["current_key"] != key:
            raise BridgeError("conflict", "This problem is no longer the one being shown")
        problem = self.bank(session["language"]).by_key.get(key)
        if problem is None:
            raise BridgeError("conflict", "This problem is no longer in the bank")
        return student, submission, problem, None

    def _finish(self, student, outcome):
        self.db.execute("COMMIT")
        outcome.update(self.state(student))
        return outcome

    def op_answer(self, request):
        letter = request.get("letter")
        if not isinstance(letter, str) or len(letter) != 1 or letter not in LETTERS:
            raise BridgeError("bad_request", "The answer must be exactly one letter A-E")
        confidence = request.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, int) or not 0 <= confidence <= 100:
            raise BridgeError("bad_request", "Confidence must be an integer from 0 to 100")
        try:
            student, submission, problem, replay = self._begin_submission(request)
            if replay is not None:
                return self._finish(student, replay)
            correct = letter == problem["label"]
            self._record(student, problem, letter, correct, confidence, submission)
            self._set_current(student, self.choose_next(student, self.bank(problem["language"])))
            outcome = {"result": {"kind": "answer", "key": self.T.problem_key(problem), "correct": correct,
                                  "letter": letter, "confidence": confidence,
                                  "explanation": self.explanation(problem)}, "replayed": False}
            return self._finish(student, outcome)
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def op_skip(self, request):
        try:
            student, submission, problem, replay = self._begin_submission(request)
            if replay is not None:
                return self._finish(student, replay)
            if not self.view(problem)["image_missing"]:
                raise BridgeError("conflict", "Only a problem whose required image is missing can be skipped")
            self.db.execute(
                "INSERT INTO lh_skips (student_id, problem_key, problem_id, reason, submission_id, ts)"
                " VALUES (?, ?, ?, 'image_missing', ?, ?)",
                (student, self.T.problem_key(problem), str(problem["id"]), submission, time.time()))
            self._set_current(student, self.choose_next(student, self.bank(problem["language"])))
            return self._finish(student, {"result": {"kind": "skip", "key": self.T.problem_key(problem)},
                                          "replayed": False})
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def _record(self, student, problem, letter, correct, confidence, submission):
        """The trainer's Profile.record, inside our transaction, plus the confidence row.

        Same columns and the same estimate_level call as Profile.record; it is
        repeated here only so the attempt, its confidence and the next problem
        commit together (Profile.record commits on its own).
        """
        T = self.T
        start = self.db.execute("SELECT start_level FROM students WHERE student_id = ?", (student,)).fetchone()[0]
        cursor = self.db.execute(
            "INSERT INTO attempts (student_id, problem_key, problem_id, level, topic, answer, correct, ts)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (student, T.problem_key(problem), str(problem["id"]), int(problem["level"]),
             T.topic_of(problem), letter, int(bool(correct)), time.time()))
        self.db.execute("INSERT INTO lh_attempts VALUES (?, ?, ?)", (cursor.lastrowid, submission, confidence))
        history = self.db.execute("SELECT level, correct FROM attempts WHERE student_id = ? ORDER BY n",
                                  (student,)).fetchall()
        estimate, sd = T.estimate_level(history, start)
        self.db.execute("UPDATE students SET level_est = ?, level_sd = ?, updated = ? WHERE student_id = ?",
                        (estimate, sd, time.time(), student))

    def handle(self, request):
        if not isinstance(request, dict):
            raise BridgeError("bad_request", "The request must be a JSON object")
        op = request.get("op")
        method = getattr(self, f"op_{op}", None) if isinstance(op, str) and op.isidentifier() else None
        if method is None:
            raise BridgeError("bad_request", f"Unknown operation: {op!r}")
        return method(request)


def load_explanations(path):
    """{problem id: text | {language: text}}; a missing or unreadable file means no explanations."""
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        sys.stderr.write(f"[practice] explanations not loaded from {path}: {e}" + chr(10))
        return {}
    return data if isinstance(data, dict) else {}


def student_id(request):
    value = request.get("student")
    if not isinstance(value, str) or not STUDENT_ID.match(value.strip()) or value != value.strip():
        raise BridgeError("bad_request", "The student name must be 1-40 characters without control characters")
    return value


def from_env():
    return Bridge(os.environ.get("LH_TRAINER_PY", ""),
                  [p for p in os.environ.get("LH_BANK", "").split(os.pathsep) if p],
                  os.environ.get("LH_IMAGES", ""),
                  os.environ.get("LH_PRACTICE_DB", ""),
                  os.environ.get("LH_EXPLANATIONS", ""))


def main():
    try:
        request = json.loads(sys.stdin.read() or "null")
        bridge = from_env()
        reply = {"ok": True, **bridge.handle(request)}
    except BridgeError as e:
        reply = {"ok": False, "error": {"code": e.code, "message": e.message, **e.extra}}
    except (json.JSONDecodeError, sqlite3.Error) as e:
        reply = {"ok": False, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}}
    sys.stdout.write(json.dumps(reply, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
