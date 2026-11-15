"""The adaptive trainer: pick the next M3Kang problem and track the student's level.

No language model in the loop, so each step is instant. Standard library only,
so it runs on the UNO Q.

- Right answer: the most similar unseen problem, one level up.
- Wrong answer: one level down, on the same topic when `topic` is known,
  then the most similar.
- Never the same problem twice: the same `id` in another language counts as seen.
- The level is a Bayesian estimate on a grid, with a logistic model of
  P(right | student level - problem level) that allows for guessing (5 options).
- The student's profile and every answer live in SQLite.

The similarity is a plain function `similarity(a, b) -> float`. The default is
offline and cheap (Jaccard of the words, plus a bonus for the same topic). On
the board, plug in the vectors that build_index.py already stored:

    similarity = make_vector_similarity(load_index_vectors("data/index.db"))

    python3 -m copilot.teach.trainer              # self-tests + simulated students
    python3 -m copilot.teach.trainer --synthetic  # same, on a made-up bank
"""
import argparse
import json
import math
import os
import random
import re
import sqlite3
import threading
import time
from array import array
from functools import lru_cache

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DB = os.environ.get("TEACH_DB", os.path.join(ROOT, "results", "teach_profiles.db"))

LEVEL_MIN, LEVEL_MAX = 0, 7
START_LEVEL = 3.5   # when we know nothing about the student
PRIOR_SD = 2.0      # wide: the first answers move the estimate a lot
SLOPE = 1.2         # how fast P(right) drops for each level above the student
GUESS = 0.2         # 5 options
LAPSE = 0.05        # a strong student can still slip on an easy problem
GRID = [round(LEVEL_MIN - 1 + i * 0.1, 1) for i in range(10 * (LEVEL_MAX - LEVEL_MIN + 2) + 1)]
TOPIC_BONUS = 0.5   # added to the similarity when both problems share a topic


# --- Problems -----------------------------------------------------------------

def problem_key(p):
    """Same key as copilot/rag.py: id|language."""
    return f"{p['id']}|{p.get('language', '')}"


def is_playable(p):
    """The student can answer it on the web page: five text options and a label."""
    options = p.get("options") or {}
    return all(options.get(letter) for letter in "ABCDE") and p.get("label") in options


def position(p):
    """Problem number inside its exam (ids look like lvl-0_2015_13): lower is easier."""
    tail = str(p.get("id", "")).rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def topic_of(p):
    """The topic, or None while the data has no `topic` field."""
    topic = p.get("topic")
    return topic.strip().lower() if isinstance(topic, str) and topic.strip() else None


def public(p):
    """What the web page may see: everything but the answer."""
    if p is None:
        return None
    view = {k: v for k, v in p.items() if k != "label"}
    view["key"] = problem_key(p)
    return view


def clamp_level(x):
    return min(LEVEL_MAX, max(LEVEL_MIN, x))


class Bank:
    """The problems the student can get, grouped by level.

    Kangaroo reuses a problem in two levels of the same year, with another id
    and the options shuffled. Those twins share a group, so seeing one counts
    as seeing both. Variants with other numbers are not twins: they are the
    best "similar" problems.
    """

    def __init__(self, problems, language=None, playable=is_playable, text_only=False):
        self.by_key, self.by_level = {}, {}
        for p in problems:
            if language and p.get("language") != language:
                continue
            if text_only and not p.get("text_only", True):
                continue
            if not playable(p):
                continue
            p = dict(p, level=int(p["level"]))
            key = problem_key(p)
            if key not in self.by_key:
                self.by_key[key] = p
                self.by_level.setdefault(p["level"], []).append(p)
        self.levels = sorted(self.by_level)
        self.groups = find_twins(self.by_key.values())

    def __len__(self):
        return len(self.by_key)

    def group(self, problem_id):
        return self.groups.get(problem_id, problem_id)

    def unseen(self, level, seen):
        """Problems at `level` whose id (or twin) the student hasn't seen."""
        blocked = {self.group(i) for i in seen}
        return [p for p in self.by_level.get(level, []) if self.group(p["id"]) not in blocked]


def _signature(p):
    """All the words and numbers of the text, without the problem number."""
    text = re.sub(r"^\s*\d+\s*[.)]\s*", "", p.get("text", "").lower())
    options = sorted(re.sub(r"\s", "", str(v)) for v in (p.get("options") or {}).values())
    return frozenset(re.findall(r"\w+", text)), options


def find_twins(problems, same_text=0.9, same_text_and_options=0.8):
    """{id: group id} for the same problem reused in another level of the same year."""
    parent = {}

    def root(i):
        while parent.get(i, i) != i:
            i = parent[i]
        return i

    by_year = {}
    for p in problems:
        by_year.setdefault(p.get("year"), []).append((p, _signature(p)))
    for year, items in by_year.items():
        if year is None:
            continue
        for i, (a, (words_a, options_a)) in enumerate(items):
            for b, (words_b, options_b) in items[i + 1:]:
                if a["level"] == b["level"] or a["id"] == b["id"]:
                    continue
                similar = jaccard(words_a, words_b)
                if similar >= same_text or (similar >= same_text_and_options and options_a == options_b):
                    parent[root(b["id"])] = root(a["id"])
    return {i: root(i) for i in parent}


def load_jsonl(*paths):
    """Problems from every path that exists (data/train.jsonl may not be there yet)."""
    problems = []
    for path in paths:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                problems.extend(json.loads(line) for line in f if line.strip())
    return problems


# --- Similarity (injectable) ----------------------------------------------------

STOPWORDS = frozenset("""
the and for with that this what which how many much are has have from into than then there their they
each was were its his her she you your will can does did not but all
els les los las del dels una uns unes que com per amb són quants quantes quina quin
por con para cuántos cuántas cuál uno unos están
""".split())
WORD = re.compile(r"[^\W\d_]{3,}")  # letters only, 3 or more, any language


@lru_cache(maxsize=None)
def words(text):
    return frozenset(w for w in WORD.findall(text.lower()) if w not in STOPWORDS)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    common = len(a & b)
    return common / (len(a) + len(b) - common)


def default_similarity(a, b):
    """Offline and cheap: shared words, plus a bonus for the same topic."""
    score = jaccard(words(a.get("text", "")), words(b.get("text", "")))
    topic = topic_of(a)
    if topic and topic == topic_of(b):
        score += TOPIC_BONUS
    return score


def load_index_vectors(db_path):
    """The vectors build_index.py stored (copilot/rag.py format). No embedding server needed."""
    db = sqlite3.connect(db_path)
    vectors = {}
    for key, blob in db.execute("SELECT key, vec FROM problems"):
        vec = array("f")
        vec.frombytes(blob)
        vectors[key] = vec
    db.close()
    return vectors


def make_vector_similarity(vectors, fallback=default_similarity):
    """Cosine of stored unit vectors (key id|language). bge-small is English, so a
    problem without its own vector uses the English version of the same id."""
    def vector(p):
        v = vectors.get(problem_key(p))
        return v if v is not None else vectors.get(f"{p['id']}|eng")

    def similarity(a, b):
        va, vb = vector(a), vector(b)
        if va is None or vb is None:
            return fallback(a, b)
        score = sum(x * y for x, y in zip(va, vb))
        topic = topic_of(a)
        if topic and topic == topic_of(b):
            score += TOPIC_BONUS
        return score
    return similarity


# --- Choosing the next problem ------------------------------------------------------

def next_level(level, correct):
    return clamp_level(level + (1 if correct else -1))


def level_order(target, direction, levels):
    """The target level first, then the nearest ones; on a tie, keep going the same way."""
    return sorted(levels, key=lambda lv: (abs(lv - target), (lv - target) * direction < 0))


def first_problem(bank, level, seen=()):
    """The easiest unseen problem at the student's level."""
    bank = bank if isinstance(bank, Bank) else Bank(bank)
    for lv in level_order(clamp_level(int(level + 0.5)), -1, bank.levels):
        candidates = bank.unseen(lv, seen)
        if candidates:
            return min(candidates, key=lambda p: (position(p), problem_key(p)))
    return None


def next_problem(bank, last, correct, seen=(), similarity=default_similarity):
    """The problem to show after `last` was answered, right or wrong.

    Right: the most similar unseen problem one level up.
    Wrong: one level down, the same topic first (if known), then the most similar.
    If that level has nothing left, the nearest level that does. None when the bank is empty.
    `seen` holds problem ids: other languages and twins of a seen problem count as seen.
    """
    bank = bank if isinstance(bank, Bank) else Bank(bank)
    seen = set(seen) | {last["id"]}
    topic = None if correct else topic_of(last)
    for lv in level_order(next_level(int(last["level"]), correct), 1 if correct else -1, bank.levels):
        candidates = bank.unseen(lv, seen)
        if not candidates:
            continue
        if topic:
            candidates = [p for p in candidates if topic_of(p) == topic] or candidates
        return max(candidates, key=lambda p: (similarity(last, p), -position(p), problem_key(p)))
    return None


# --- Level estimate ---------------------------------------------------------------

def p_correct(ability, level, slope=SLOPE, guess=GUESS, lapse=LAPSE):
    """P(right answer) for a student of `ability` on a problem of `level`."""
    return guess + (1 - guess - lapse) / (1 + math.exp(-slope * (ability - level)))


@lru_cache(maxsize=None)
def _log_likelihood(level, correct):
    return tuple(math.log(p_correct(t, level) if correct else 1 - p_correct(t, level)) for t in GRID)


def estimate_level(history, start=START_LEVEL, prior_sd=PRIOR_SD):
    """history: (problem level, right?) pairs. Returns the posterior mean and sd."""
    log_post = [-0.5 * ((t - start) / prior_sd) ** 2 for t in GRID]
    for level, correct in history:
        log_post = [a + b for a, b in zip(log_post, _log_likelihood(int(level), bool(correct)))]
    top = max(log_post)
    weights = [math.exp(x - top) for x in log_post]
    total = sum(weights)
    mean = sum(w * t for w, t in zip(weights, GRID)) / total
    sd = math.sqrt(sum(w * (t - mean) ** 2 for w, t in zip(weights, GRID)) / total)
    return mean, sd


# --- Student profile in SQLite ------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    student_id  TEXT PRIMARY KEY,
    start_level REAL NOT NULL,
    level_est   REAL NOT NULL,
    level_sd    REAL NOT NULL,
    updated     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
    n           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    problem_key TEXT NOT NULL,
    problem_id  TEXT NOT NULL,
    level       INTEGER NOT NULL,
    topic       TEXT,
    answer      TEXT NOT NULL,
    correct     INTEGER NOT NULL,
    ts          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_by_student ON attempts (student_id, n);
"""


class Profile:
    """Every student's level and answers. Use path=":memory:" in tests."""

    def __init__(self, path=None):
        path = path or DEFAULT_DB
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        # The web server may call from several threads: one connection, one lock
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript(SCHEMA)

    def student(self, student_id, start_level=None):
        """The student's row; a new student starts at start_level (or the middle)."""
        with self.lock:
            row = self.db.execute("SELECT * FROM students WHERE student_id = ?", (student_id,)).fetchone()
            if row is None:
                start = START_LEVEL if start_level is None else float(start_level)
                self.db.execute("INSERT INTO students VALUES (?, ?, ?, ?, ?)",
                                (student_id, start, start, PRIOR_SD, time.time()))
                self.db.commit()
                row = self.db.execute("SELECT * FROM students WHERE student_id = ?", (student_id,)).fetchone()
            return dict(row)

    def attempts(self, student_id):
        with self.lock:
            rows = self.db.execute("SELECT * FROM attempts WHERE student_id = ? ORDER BY n", (student_id,))
            return [dict(r) for r in rows]

    def seen_ids(self, student_id):
        with self.lock:
            rows = self.db.execute("SELECT DISTINCT problem_id FROM attempts WHERE student_id = ?", (student_id,))
            return {r[0] for r in rows}

    def record(self, student_id, problem, answer, correct):
        """Store one answer and update the level. Returns (estimate, sd)."""
        with self.lock:
            start = self.student(student_id)["start_level"]
            self.db.execute(
                "INSERT INTO attempts (student_id, problem_key, problem_id, level, topic, answer, correct, ts)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (student_id, problem_key(problem), str(problem["id"]), int(problem["level"]),
                 topic_of(problem), answer, int(bool(correct)), time.time()))
            history = self.db.execute("SELECT level, correct FROM attempts WHERE student_id = ? ORDER BY n",
                                      (student_id,)).fetchall()
            estimate, sd = estimate_level(history, start)
            self.db.execute("UPDATE students SET level_est = ?, level_sd = ?, updated = ? WHERE student_id = ?",
                            (estimate, sd, time.time(), student_id))
            self.db.commit()
        return estimate, sd

    def summary(self, student_id):
        """For the web page: level, answers, and right/total by topic and by level."""
        student = self.student(student_id)
        attempts = self.attempts(student_id)
        by_topic, by_level = {}, {}
        for a in attempts:
            for table, key in ((by_topic, a["topic"] or "?"), (by_level, a["level"])):
                right, total = table.get(key, (0, 0))
                table[key] = (right + a["correct"], total + 1)
        estimate = clamp_level(student["level_est"])
        return {"student_id": student_id, "level": int(estimate + 0.5), "level_est": round(estimate, 2),
                "level_sd": round(student["level_sd"], 2), "answered": len(attempts),
                "right": sum(a["correct"] for a in attempts), "by_topic": by_topic, "by_level": by_level}

    def close(self):
        self.db.close()


# --- What the web page calls ----------------------------------------------------------

class Trainer:
    """The bank, the profiles and the similarity together: two calls for the web page."""

    def __init__(self, bank, profile=None, similarity=default_similarity):
        self.bank = bank if isinstance(bank, Bank) else Bank(bank)
        self.profile = profile if profile is not None else Profile()
        self.similarity = similarity

    def start(self, student_id, start_level=None):
        """The problem to show now: the first one, or the next one after the last answer."""
        student = self.profile.student(student_id, start_level)
        attempts = self.profile.attempts(student_id)
        seen = {a["problem_id"] for a in attempts}
        if attempts:
            last = self.bank.by_key.get(attempts[-1]["problem_key"])
            if last is not None:
                return public(next_problem(self.bank, last, attempts[-1]["correct"], seen, self.similarity))
        return public(first_problem(self.bank, student["level_est"], seen))

    def answer(self, student_id, key, letter):
        """Check the letter, store it, and choose the next problem. Never returns the right letter."""
        problem = self.bank.by_key[key]
        letter = str(letter).strip().upper()[:1]
        correct = letter == problem["label"]
        estimate, sd = self.profile.record(student_id, problem, letter, correct)
        upcoming = next_problem(self.bank, problem, correct, self.profile.seen_ids(student_id), self.similarity)
        estimate = clamp_level(estimate)
        return {"correct": correct, "level": int(estimate + 0.5), "level_est": round(estimate, 2),
                "level_sd": round(sd, 2), "next": public(upcoming)}


# --- Self-tests -----------------------------------------------------------------------

_TOPIC_WORDS = {
    "geometry": "square triangle circle area perimeter side angle rectangle length figure cube edge",
    "counting": "ways different arrange choose order pairs digits combinations list possible teams seats",
    "arithmetic": "sum product apples price coins cost total left more less pay euros",
    "logic": "true false liar says knights statement lies always never truth told island",
    "algebra": "equation value unknown solve expression times equal greater smaller variable result twice",
}
_COMMON = "kangaroo picture shown below question children class school game box friends day".split()


def synthetic_bank(per_cell=12, seed=0):
    """Made-up problems with the M3Kang fields: 8 levels x 5 topics x per_cell."""
    rng = random.Random(seed)
    problems = []
    for level in range(LEVEL_MIN, LEVEL_MAX + 1):
        for topic, vocabulary in _TOPIC_WORDS.items():
            vocabulary = vocabulary.split()
            for i in range(per_cell):
                values = rng.sample(range(1, 100), 5)
                problems.append({
                    "id": f"syn-{level}-{topic}_{i + 1}", "language": "eng", "level": level,
                    "year": 2020 + i % 5, "text_only": True, "topic": topic,
                    "text": " ".join(rng.sample(vocabulary, 6) + rng.sample(_COMMON, 4)),
                    "options": dict(zip("ABCDE", map(str, values))), "label": rng.choice("ABCDE")})
    return problems


def _self_test():
    bank = Bank(synthetic_bank())
    last = bank.by_level[3][0]
    up, down = next_problem(bank, last, True), next_problem(bank, last, False)
    assert up["level"] == 4, "right -> one level up"
    assert down["level"] == 2 and down["topic"] == last["topic"], "wrong -> one level down, same topic"
    assert next_problem(bank, bank.by_level[7][0], True)["level"] == 7, "top level stays"
    assert next_problem(bank, bank.by_level[0][0], False)["level"] == 0, "bottom level stays"

    # Without the topic field nothing breaks
    plain = Bank([{k: v for k, v in p.items() if k != "topic"} for p in bank.by_key.values()])
    assert next_problem(plain, plain.by_level[3][0], False)["level"] == 2
    real = Bank(load_jsonl(os.path.join(ROOT, "data", "sample_problems.jsonl")))
    if len(real):
        p = first_problem(real, 2)
        assert p is not None and next_problem(real, p, False) is not None

    # Never repeats, also across languages, and None when the bank runs out
    tiny = [dict(p, id=f"t_{i}") for i, p in enumerate(bank.by_level[3][:3])]
    tiny.append(dict(tiny[0], language="cat"))  # same id, other language
    seen, p = set(), tiny[0]
    while p is not None:
        assert p["id"] not in seen, "repeated problem"
        seen.add(p["id"])
        p = next_problem(tiny, p, True, seen)
    assert seen == {"t_0", "t_1", "t_2"}

    # The same problem reused one level up (another id, options shuffled) counts as seen
    options = last["options"]
    twin = dict(last, id="twin_1", level=4, options={k: options[v] for k, v in zip("ABCDE", "EDCBA")})
    twins = Bank(list(bank.by_key.values()) + [twin])
    assert twins.group("twin_1") == twins.group(last["id"])
    assert next_problem(twins, last, True)["id"] != "twin_1", "twin offered again"

    # The similarity is injectable
    wanted = bank.by_level[4][-1]
    pick = next_problem(bank, last, True, similarity=lambda a, b: float(b is wanted))
    assert pick is wanted, "injected similarity not used"
    vectors = {problem_key(last): array("f", [1, 0]), problem_key(wanted): array("f", [1, 0])}
    for p in bank.by_level[4]:
        vectors.setdefault(problem_key(p), array("f", [0, 1]))
    assert next_problem(bank, last, True, similarity=make_vector_similarity(vectors)) is wanted

    # The estimate moves the right way
    assert estimate_level([(5, True)] * 6)[0] > 5
    assert estimate_level([(2, False)] * 6)[0] < 2

    # SQLite profile + the web calls; the answer never leaves the trainer
    trainer = Trainer(bank, Profile(":memory:"))
    shown = trainer.start("ana", start_level=2)
    assert "label" not in shown and shown["level"] == 2
    result = trainer.answer("ana", shown["key"], bank.by_key[shown["key"]]["label"].lower())
    assert result["correct"] and result["next"]["level"] == 3 and "label" not in result["next"]
    result = trainer.answer("ana", result["next"]["key"], "Z")
    assert not result["correct"] and result["next"]["level"] == 2
    resumed = trainer.start("ana")  # e.g. after a reboot: same rule, no repeats
    assert resumed["key"] == result["next"]["key"]
    summary = trainer.profile.summary("ana")
    assert summary["answered"] == 2 and summary["right"] == 1
    print("Self-tests: OK")


# --- Simulated students -------------------------------------------------------------

STUDENTS = {
    "logistic": ("logística (pendiente 1,2, azar 20 %)",
                 lambda real, level, rng: rng.random() < p_correct(real, level, SLOPE, GUESS, 0.0)),
    "flat": ("logística más plana (pendiente 0,7)",
             lambda real, level, rng: rng.random() < p_correct(real, level, 0.7, GUESS, 0.0)),
    "threshold": ("umbral del README (bien debajo, mal encima)",
                  lambda real, level, rng: level < real or (level == real and rng.random() < 0.5)),
}


def simulate(bank, real_level, seed, student="logistic", steps=20, similarity=default_similarity,
             start_level=START_LEVEL):
    """One simulated student, end to end through Trainer and SQLite."""
    rng = random.Random(f"{student}-{real_level}-{seed}")
    answers = STUDENTS[student][1]
    trainer = Trainer(bank, Profile(":memory:"), similarity)
    shown = trainer.start("sim", start_level)
    trace = []
    while shown is not None and len(trace) < steps:
        problem = bank.by_key[shown["key"]]
        correct = answers(real_level, problem["level"], rng)
        letter = problem["label"] if correct else rng.choice([x for x in "ABCDE" if x != problem["label"]])
        start = time.perf_counter()
        result = trainer.answer("sim", shown["key"], letter)
        trace.append({"problem": problem, "correct": correct, "estimate": result["level_est"],
                      "ms": 1000 * (time.perf_counter() - start)})
        shown = result["next"]
    trainer.profile.close()
    return trace


def _at(trace, k):
    return trace[min(k, len(trace)) - 1]


def _staircase(trace, k, window=6):
    """Baseline estimate: the mean level of the last problems shown."""
    levels = [t["problem"]["level"] for t in trace[:k]][-window:]
    return sum(levels) / len(levels)


def run_metric(bank, seeds=20, steps=20, similarity=default_similarity):
    checkpoints = [k for k in (5, 10, 20) if k <= steps] or [steps]
    real_levels = list(range(LEVEL_MIN, LEVEL_MAX + 1))
    results = {}
    for student in STUDENTS:
        results[student] = {real: [simulate(bank, real, s, student, steps, similarity) for s in range(seeds)]
                            for real in real_levels}

    def mae(traces, k, estimate=lambda tr, k: _at(tr, k)["estimate"]):
        return sum(abs(estimate(tr, k) - real) for real, trs in traces.items() for tr in trs) / \
            sum(len(trs) for trs in traces.values())

    main = results["logistic"]
    head = "".join(f"  tras {k:<3}" for k in checkpoints)
    print(f"\nError absoluto medio del nivel estimado, alumno {STUDENTS['logistic'][0]},")
    print(f"{seeds} semillas por nivel real, empieza en el nivel {int(START_LEVEL + 0.5)} (sin saber nada):\n")
    print(f"nivel real{head}  escalera@{steps}  nivel final (media)")
    for real in real_levels:
        row = "".join(f"  {mae({real: main[real]}, k):8.2f}" for k in checkpoints)
        final = sum(_at(tr, steps)["estimate"] for tr in main[real]) / len(main[real])
        print(f"{real:>10}{row}  {mae({real: main[real]}, steps, _staircase):11.2f}  {final:19.2f}")
    row = "".join(f"  {mae(main, k):8.2f}" for k in checkpoints)
    print(f"{'media':>10}{row}  {mae(main, steps, _staircase):11.2f}")

    print(f"\nRobustez (media de los {len(real_levels)} niveles reales):\n")
    print(f"{'alumno simulado':<46}{head}")
    for student, (name, _) in STUDENTS.items():
        print(f"{name:<46}" + "".join(f"  {mae(results[student], k):8.2f}" for k in checkpoints))
    blind = sum(abs(START_LEVEL - r) for r in real_levels) / len(real_levels)
    print(f"{'sin datos (siempre ' + str(START_LEVEL) + ')':<46}" + "".join(f"  {blind:8.2f}" for _ in checkpoints))

    # Speed and path quality, on every simulated step
    traces = [tr for by_real in results.values() for trs in by_real.values() for tr in trs]
    times = sorted(t["ms"] for tr in traces for t in tr)
    rng = random.Random(0)
    similar = baseline = same_topic = random_topic = after_wrong = pairs = 0
    for tr in traces:
        for prev, nxt in zip(tr, tr[1:]):
            a, b = prev["problem"], nxt["problem"]
            other = rng.choice(bank.by_level[b["level"]])
            similar += jaccard(words(a["text"]), words(b["text"]))
            baseline += jaccard(words(a["text"]), words(other["text"]))
            pairs += 1
            if not prev["correct"] and topic_of(a):
                after_wrong += 1
                same_topic += topic_of(a) == topic_of(b)
                random_topic += topic_of(a) == topic_of(other)
    print(f"\nTiempo por paso (answer: SQLite + estimación + elección), {len(times)} pasos: "
          f"mediana {times[len(times) // 2]:.1f} ms, p99 {times[int(len(times) * 0.99)]:.1f} ms "
          f"(portátil; en la placa hay que medirlo)")
    print(f"Parecido (Jaccard de palabras entre problemas seguidos): {similar / pairs:.3f}, "
          f"frente a {baseline / pairs:.3f} con uno al azar del mismo nivel")
    repeated = sum(len({bank.group(t["problem"]["id"]) for t in tr}) < len(tr) for tr in traces)
    print(f"Alumnos que vieron un problema repetido (mismo id o gemelo de otro nivel): {repeated} de {len(traces)}"
          f" ({len(set(bank.groups.values()))} grupos de gemelos en el banco)")
    if after_wrong:
        print(f"Mismo tema tras un fallo: {100 * same_topic / after_wrong:.0f} %, "
              f"frente a {100 * random_topic / after_wrong:.0f} % al azar")
    else:
        print("Mismo tema tras un fallo: n/d (los datos aún no tienen el campo topic)")
    return mae(main, steps)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", nargs="*", default=[os.path.join(ROOT, "data", "val.jsonl"),
                                                       os.path.join(ROOT, "data", "train.jsonl")])
    parser.add_argument("--synthetic", action="store_true", help="use made-up problems, not M3Kang")
    parser.add_argument("--language", default="", help="default: the language with most playable problems")
    parser.add_argument("--index", default="", help="e.g. data/index.db: similarity from the RAG vectors")
    parser.add_argument("--seeds", type=int, default=20)
    parser.add_argument("--steps", type=int, default=20)
    args = parser.parse_args()

    _self_test()
    problems = [] if args.synthetic else load_jsonl(*args.data)
    source = "M3Kang (" + ", ".join(os.path.basename(p) for p in args.data if os.path.exists(p)) + ")"
    language = args.language
    if problems and not language:
        counts = {}
        for p in problems:
            if is_playable(p):
                counts[p.get("language")] = counts.get(p.get("language"), 0) + 1
        language = max(counts, key=counts.get) if counts else ""
    bank = Bank(problems, language=language or None)
    if len(bank) < 50 or len(bank.levels) < 4:
        source, bank = "sintético (8 niveles x 5 temas x 12)", Bank(synthetic_bank())
        if not args.synthetic:
            source += ", porque aún no hay data/train.jsonl ni data/val.jsonl"
    similarity = make_vector_similarity(load_index_vectors(args.index)) if args.index else default_similarity
    print(f"\nBanco: {source}, {len(bank)} problemas jugables"
          + (f" en '{language}'" if language and not source.startswith("sint") else "")
          + ", por nivel: " + " ".join(f"{lv}:{len(bank.by_level[lv])}" for lv in bank.levels))
    run_metric(bank, args.seeds, args.steps, similarity)


if __name__ == "__main__":
    main()
