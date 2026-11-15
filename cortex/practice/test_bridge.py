"""Tests for practice/bridge.py on a synthetic bank (no M3Kang data needed).

    LH_TRAINER_PY=/path/to/copilot/teach/trainer.py python3 -m unittest practice/test_bridge.py

The trainer path defaults, as in the app, to ../copilot/teach/trainer.py (the
team repository) or else ../../wt-teach/copilot/teach/trainer.py.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
TRAINER = os.environ.get("LH_TRAINER_PY") or next(
    (p for p in (os.path.join(APP, "..", "copilot", "teach", "trainer.py"),
                 os.path.join(APP, "..", "..", "wt-teach", "copilot", "teach", "trainer.py")) if os.path.isfile(p)),
    os.path.join(APP, "..", "copilot", "teach", "trainer.py"))
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def synthetic_problems():
    """8 levels x 4 problems in English, plus Catalan twins of the same ids."""
    problems = []
    nouns = "apples pears coins cubes marbles stamps tiles beads".split()
    verbs = "counts shares stacks paints sorts trades splits joins".split()
    for level in range(8):
        for i in range(4):
            pid = f"lvl-{level}_2020_{i + 1}"
            base = {"id": pid, "level": level, "year": 2020, "label": "ABCDE"[(level + i) % 5]}
            if i == 3:  # options are pictures: the image is required
                extra = {"text_only": False, "options": {}}
            elif i == 2:  # a figure, options readable
                extra = {"text_only": False, "options": {x: f"${level}+{n}$" for n, x in enumerate("ABCDE")}}
            else:
                extra = {"text_only": True, "options": {x: str(10 * level + n) for n, x in enumerate("ABCDE")}}
            problems.append({**base, **extra, "language": "eng",
                             "text": f"{i + 1}. Anna {verbs[(level + i) % 8]} {nouns[(2 * level + i) % 8]}"
                                     f" {'after lunch' if i % 2 else 'before school'}. How many? $x^{level}$"})
            problems.append({**base, **extra, "language": "cat",
                             "text": f"{i + 1}. Quantes {nouns[(2 * level + i) % 8]}? {verbs[(level + i) % 8]}"})
    return problems


class Fixture:
    def __init__(self, missing_images=()):
        self.dir = tempfile.TemporaryDirectory()
        root = self.dir.name
        self.bank = os.path.join(root, "bank.jsonl")
        self.images = os.path.join(root, "images")
        self.db = os.path.join(root, "practice.db")
        self.explanations = os.path.join(root, "explanations.json")
        os.makedirs(self.images)
        self.problems = synthetic_problems()
        with open(self.bank, "w", encoding="utf-8") as f:
            for p in self.problems:
                f.write(json.dumps(p) + "\n")
                key = f"{p['id']}_{p['language']}"
                if key not in missing_images:
                    with open(os.path.join(self.images, key + ".png"), "wb") as img:
                        img.write(PNG)
        self.labels = {f"{p['id']}|{p['language']}": p["label"] for p in self.problems}
        # Explanations for every level-3 and level-4 problem except the last of each level
        explained = {p["id"]: {"eng": f"Because {p['id']} works out to {p['label']}.", "cat": f"Perquè {p['id']}."}
                     for p in self.problems if p["level"] in (3, 4) and not p["id"].endswith("_4")}
        with open(self.explanations, "w", encoding="utf-8") as f:
            json.dump(explained, f)

    def env(self):
        return {**os.environ, "LH_TRAINER_PY": TRAINER, "LH_BANK": self.bank,
                "LH_IMAGES": self.images, "LH_PRACTICE_DB": self.db, "LH_EXPLANATIONS": self.explanations}

    def call(self, **request):
        """One request through the real stdin/stdout protocol, in a fresh process."""
        out = subprocess.run([sys.executable, os.path.join(HERE, "bridge.py")], input=json.dumps(request),
                             capture_output=True, text=True, env=self.env(), timeout=60, check=True)
        return json.loads(out.stdout)

    def close(self):
        self.dir.cleanup()


def submission(n):
    return f"sub-{n:08d}"


@unittest.skipUnless(os.path.isfile(TRAINER), f"trainer not found at {TRAINER}")
class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def start(self, student="ana", language="eng"):
        reply = self.fx.call(op="start", student=student, language=language)
        self.assertTrue(reply["ok"], reply)
        return reply

    def answer(self, problem, letter, n, confidence=70, student="ana"):
        return self.fx.call(op="answer", student=student, key=problem["key"], letter=letter,
                            confidence=confidence, submission_id=submission(n))

    def test_labels_never_reach_the_browser(self):
        reply = self.start()
        text = json.dumps(reply)
        self.assertNotIn('"label"', text)
        for n in range(6):
            problem = reply["problem"]
            reply = self.answer(problem, "A", n)
            self.assertTrue(reply["ok"], reply)
            self.assertNotIn('"label"', json.dumps(reply))

    def test_full_session_right_and_wrong(self):
        reply = self.start()
        first = reply["problem"]
        self.assertEqual(first["language"], "eng")
        right = self.fx.labels[first["key"]]
        reply = self.answer(first, right, 1, confidence=90)
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["result"]["correct"])
        self.assertEqual(reply["problem"]["level"], first["level"] + 1, "right -> one level up")
        second = reply["problem"]
        wrong = next(x for x in "ABCDE" if x != self.fx.labels[second["key"]])
        reply = self.answer(second, wrong, 2, confidence=30)
        self.assertFalse(reply["result"]["correct"])
        self.assertEqual(reply["problem"]["level"], second["level"] - 1, "wrong -> one level down")
        self.assertEqual(reply["student"]["answered"], 2)
        self.assertEqual(reply["student"]["right"], 1)
        self.assertNotEqual(reply["problem"]["key"], first["key"], "never repeats")

    def test_confidence_is_stored_with_the_attempt(self):
        import sqlite3
        reply = self.start()
        for n, confidence in enumerate([0, 50, 100]):
            reply = self.answer(reply["problem"], "B", n, confidence=confidence)
            self.assertTrue(reply["ok"], reply)
        db = sqlite3.connect(self.fx.db)
        rows = db.execute("SELECT a.n, a.answer, m.confidence FROM attempts a"
                          " JOIN lh_attempts m ON m.attempt_n = a.n ORDER BY a.n").fetchall()
        self.assertEqual([r[2] for r in rows], [0, 50, 100])
        self.assertEqual(db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 3)

    def test_invalid_answers_are_refused(self):
        problem = self.start()["problem"]
        for letter in ["", "AB", "a", "F", 1, None]:
            reply = self.fx.call(op="answer", student="ana", key=problem["key"], letter=letter,
                                 confidence=50, submission_id=submission(9))
            self.assertEqual(reply["error"]["code"], "bad_request", letter)
        for confidence in [-1, 101, 50.5, "50", True, None]:
            reply = self.fx.call(op="answer", student="ana", key=problem["key"], letter="A",
                                 confidence=confidence, submission_id=submission(9))
            self.assertEqual(reply["error"]["code"], "bad_request", confidence)
        state = self.fx.call(op="state", student="ana")
        self.assertEqual(state["student"]["answered"], 0)

    def test_double_submit_records_once_and_advances_once(self):
        problem = self.start()["problem"]
        first = self.answer(problem, "C", 1)
        again = self.answer(problem, "C", 1)
        self.assertTrue(again["ok"] and again["replayed"])
        self.assertEqual(again["result"], first["result"])
        self.assertEqual(again["problem"]["key"], first["problem"]["key"], "did not advance twice")
        self.assertEqual(again["student"]["answered"], 1)
        # A new submission id for the old problem is stale
        stale = self.answer(problem, "D", 2)
        self.assertEqual(stale["error"]["code"], "conflict")
        self.assertEqual(self.fx.call(op="state", student="ana")["student"]["answered"], 1)

    def test_concurrent_double_submit(self):
        problem = self.start()["problem"]
        replies = []
        threads = [threading.Thread(target=lambda: replies.append(self.answer(problem, "E", 7)))
                   for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertTrue(all(r["ok"] for r in replies), replies)
        self.assertEqual(sum(not r["replayed"] for r in replies), 1)
        self.assertEqual(len({r["problem"]["key"] for r in replies}), 1)
        self.assertEqual(self.fx.call(op="state", student="ana")["student"]["answered"], 1)

    def test_resume_returns_the_same_problem(self):
        reply = self.start()
        reply = self.answer(reply["problem"], "A", 1)
        shown = reply["problem"]["key"]
        resumed = self.fx.call(op="state", student="ana")
        self.assertEqual(resumed["problem"]["key"], shown)
        again = self.start()  # start on an existing session resumes, keeps the language
        self.assertEqual(again["problem"]["key"], shown)
        self.assertEqual(self.fx.call(op="start", student="ana", language="cat")["student"]["language"], "eng")
        profiles = self.fx.call(op="profiles")
        self.assertEqual([p["student_id"] for p in profiles["profiles"]], ["ana"])
        self.assertEqual(profiles["languages"], {"eng": 32, "cat": 32})

    def test_other_language_of_the_same_id_counts_as_seen(self):
        reply = self.start(student="pau", language="cat")
        seen = set()
        for n in range(12):
            problem = reply["problem"]
            if problem is None:
                break
            self.assertEqual(problem["language"], "cat")
            self.assertNotIn(problem["id"], seen)
            seen.add(problem["id"])
            if problem["image_missing"]:
                reply = self.fx.call(op="skip", student="pau", key=problem["key"], submission_id=submission(n))
            else:
                reply = self.answer(problem, self.fx.labels[problem["key"]], n, student="pau")

    def test_unknown_student_and_language(self):
        self.assertIsNone(self.fx.call(op="state", student="nadie")["student"])
        self.assertEqual(self.fx.call(op="start", student="x", language="deu")["error"]["code"], "bad_request")
        self.assertEqual(self.fx.call(op="start", student="", language="eng")["error"]["code"], "bad_request")
        self.assertEqual(self.fx.call(op="nope")["error"]["code"], "bad_request")

    def test_explanation_only_after_answering(self):
        reply = self.start()
        problem = reply["problem"]
        self.assertEqual(problem["level"], 4)
        self.assertNotIn("explanation", json.dumps(reply), "never shown before answering")
        answered = self.answer(problem, "A", 1)
        self.assertEqual(answered["result"]["explanation"], f"Because {problem['id']} works out to {self.fx.labels[problem['key']]}.")
        self.assertNotIn("explanation", json.dumps(answered["problem"]), "the next problem carries none")
        again = self.answer(problem, "A", 1)
        self.assertTrue(again["replayed"])
        self.assertEqual(again["result"]["explanation"], answered["result"]["explanation"])

    def test_explanation_language_and_missing(self):
        problem = self.start(student="pau", language="cat")["problem"]
        answered = self.answer(problem, "A", 1, student="pau")
        self.assertEqual(answered["result"]["explanation"], f"Perquè {problem['id']}.")
        # A problem without an entry gets null
        reply = answered
        for n in range(2, 12):
            p = reply["problem"]
            if p is None or (p["level"] not in (3, 4) or p["id"].endswith("_4")):
                break
            reply = self.answer(p, "A", n, student="pau")
        if reply["problem"] is not None:
            last = self.answer(reply["problem"], "A", 99, student="pau")
            self.assertIsNone(last["result"]["explanation"])

    def test_image_facts(self):
        problem = self.start()["problem"]
        self.assertTrue(problem["image"])
        self.assertFalse(problem["image_missing"])
        number = int(problem["id"].rsplit("_", 1)[1])
        self.assertEqual(problem["options_in_image"], number == 4)
        self.assertEqual(problem["image_required"], number >= 3)


@unittest.skipUnless(os.path.isfile(TRAINER), f"trainer not found at {TRAINER}")
class MissingImageTest(unittest.TestCase):
    def test_missing_required_image_can_be_skipped_without_penalty(self):
        # Every English figure problem lacks its image
        missing = {f"lvl-{lv}_2020_{i}_eng" for lv in range(8) for i in (3, 4)}
        fx = Fixture(missing_images=missing)
        try:
            reply = fx.call(op="start", student="eva", language="eng")
            skipped = answered = 0
            for n in range(40):
                problem = reply["problem"]
                if problem is None:
                    break
                if problem["image_missing"]:
                    self.assertTrue(problem["image_required"])
                    before = reply["student"]["level_est"]
                    reply = fx.call(op="skip", student="eva", key=problem["key"], submission_id=submission(n))
                    self.assertTrue(reply["ok"], reply)
                    self.assertEqual(reply["student"]["level_est"], before, "a skip moves nothing")
                    self.assertNotEqual(reply["problem"] and reply["problem"]["key"], problem["key"])
                    skipped += 1
                else:
                    # A problem with its image (or text only) cannot be skipped
                    refused = fx.call(op="skip", student="eva", key=problem["key"], submission_id=submission(100 + n))
                    self.assertEqual(refused["error"]["code"], "conflict")
                    reply = fx.call(op="answer", student="eva", key=problem["key"], letter="A",
                                    confidence=50, submission_id=submission(n))
                    answered += 1
            self.assertGreater(skipped, 0)
            self.assertEqual(reply["student"]["answered"], answered)
            self.assertEqual(reply["student"]["skipped"], skipped)
            self.assertTrue(reply["done"], "the bank runs out without repeats")
        finally:
            fx.close()


if __name__ == "__main__":
    unittest.main()
