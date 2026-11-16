"""Synthetic fixtures only: python3 -m unittest benchmark.test_benchmark -v."""
import copy
import json
import random
import sqlite3
import tempfile
import unittest
from pathlib import Path

from .common import inference_input, key, keyed, quality, write_json
from .data import audit, check_index, prepare, select
from .metrics import compare, percentile, summarize
from .run import Observer


def problem(pid="sample", lang="eng", text="Synthetic arithmetic example", label="B"):
    return {"id": pid, "language": lang, "text": text, "label": label, "level": 1,
            "text_only": True, "options": dict(zip("ABCDE", ["1", "2", "3", "4", "5"]))}


def jsonl(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_labels_never_enter_solver_input(self):
        p = problem()
        p.update(answer="B", solution="restricted", topic="scoring only", image="not official")
        clean = inference_input(p)
        self.assertEqual(set(clean), {"id", "language", "text", "options"})

    def test_manifest_matches_legacy_order_and_freezes_bytes(self):
        rows = [problem(str(i)) for i in range(12)]
        path = self.root / "val.jsonl"
        jsonl(path, rows)
        prepare(path, self.root / "manifests", 4)
        _, selected = select(path, self.root / "manifests/dev.json")
        random.Random(42).shuffle(rows)
        self.assertEqual([key(r) for r in selected], [key(r) for r in rows[:4]])
        path.write_text(path.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "Dataset bytes"):
            select(path, self.root / "manifests/dev.json")

    def test_translations_are_grouped_and_duplicate_keys_rejected(self):
        rows = [problem("one", "eng"), problem("one", "cat"), problem("two")]
        path = self.root / "val.jsonl"
        jsonl(path, rows)
        prepare(path, self.root / "m", 1)
        dev = json.loads((self.root / "m/dev.json").read_text())["samples"]
        final = json.loads((self.root / "m/final.json").read_text())["samples"]
        self.assertFalse({r['id'] for r in dev} & {r['id'] for r in final})
        with self.assertRaises(ValueError):
            keyed(rows + [rows[0]])

    def test_quality_is_conservative_and_preserves_numeric_values(self):
        p = problem()
        self.assertTrue(quality(p)["complete_options"])
        p["options"] = dict(zip("ABCDE", ["3.x2", "5.x2", "1.9", "2.0", "4.x2"]))
        self.assertFalse(quality(p)["duplicate_options"])
        p["options"]["E"] = " 2.0 "
        self.assertTrue(quality(p)["duplicate_options"])
        p["options"].pop("A")
        self.assertTrue(quality(p)["missing_options"])

    def test_index_guard_rejects_translation_and_cross_id_stem(self):
        train = [problem("train", text="1. Synthetic shared statement")]
        val = [problem("val", text="2. Synthetic shared statement")]
        tp, vp, dbp = [self.root / n for n in ("train.jsonl", "val.jsonl", "index.db")]
        jsonl(tp, train)
        jsonl(vp, val)
        with sqlite3.connect(dbp) as db:
            db.execute("CREATE TABLE problems (key TEXT, problem TEXT, vec BLOB)")
            db.execute("INSERT INTO problems VALUES (?, ?, ?)", ("train|eng", json.dumps(train[0]), b""))
        with self.assertRaisesRegex(ValueError, "Validation"):
            check_index(dbp, tp, vp)
        val[0]["text"] = "Completely different synthetic question"
        jsonl(vp, val)
        self.assertEqual(check_index(dbp, tp, vp)["rows"], 1)
        val[0]["id"] = "train"
        val[0]["language"] = "cat"
        jsonl(vp, val)
        with self.assertRaisesRegex(ValueError, "Validation"):
            check_index(dbp, tp, vp)

    def test_observer_does_not_modify_payload_response_or_exception(self):
        payload = {"messages": [{"role": "user", "content": "synthetic"}], "temperature": 0}
        saved = copy.deepcopy(payload)
        response = {"choices": [{"message": {"content": "B"}}], "timings": {"prompt_n": 3}}
        def post(url, data, timeout):
            self.assertIs(data, payload)
            self.assertEqual(timeout, 57)
            return response
        o = Observer(post)
        self.assertIs(o("http://127.0.0.1:8081", payload, 57), response)
        self.assertEqual(payload, saved)
        self.assertNotIn("messages", o.events[0])
        def fail(*args, **kwargs):
            raise TimeoutError()
        o = Observer(fail)
        with self.assertRaises(TimeoutError):
            o("http://127.0.0.1:8081", payload, 57)
        self.assertEqual(o.events[0]["exception"], "TimeoutError")
        with self.assertRaisesRegex(ValueError, "loopback"):
            o("https://example.com", payload, 57)
        for malformed in ([], None, {"choices": [{}]}, {"choices": [{"message": None}]}):
            o = Observer(lambda *a, **kw: malformed)
            self.assertIs(o("http://127.0.0.1:8081", payload, 57), malformed)

    def test_near_duplicate_guard_and_modified_index_labels(self):
        train = [problem("train", text="Alice has a synthetic long arithmetic task about an equal number of red boxes.")]
        val = [problem("val", text="Alice has a synthetic long arithmetic task about an equal number of blue boxes.")]
        tp, vp, dbp = [self.root / n for n in ("train.jsonl", "val.jsonl", "index.db")]
        jsonl(tp, train)
        jsonl(vp, val)
        with sqlite3.connect(dbp) as db:
            db.execute("CREATE TABLE problems (key TEXT, problem TEXT, vec BLOB)")
            db.execute("INSERT INTO problems VALUES (?, ?, ?)", ("train|eng", json.dumps(train[0]), b""))
        with self.assertRaisesRegex(ValueError, "near stem"):
            check_index(dbp, tp, vp)
        val[0]["text"] = "A completely unrelated synthetic geometry question."
        jsonl(vp, val)
        changed = dict(train[0], label="E")
        with sqlite3.connect(dbp) as db:
            db.execute("UPDATE problems SET problem=?", (json.dumps(changed),))
        with self.assertRaisesRegex(ValueError, "not identical"):
            check_index(dbp, tp, vp)

    def test_incomplete_run_and_manifest_tampering_are_rejected(self):
        from .metrics import load_results
        out = self.root / "incomplete"
        out.mkdir()
        write_json(out / "run.json", {"completed": False})
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            load_results(out)
        path = self.root / "val.jsonl"
        jsonl(path, [problem()])
        prepare(path, self.root / "manifests", 1)
        manifest_path = self.root / "manifests/dev.json"
        spec = json.loads(manifest_path.read_text())
        spec["seed"] = 99
        write_json(manifest_path, spec)
        with self.assertRaisesRegex(ValueError, "Manifest digest"):
            select(path, manifest_path)

    def test_paired_statistics_and_rejections(self):
        rows = [{"id": str(i), "language": "eng", "label": "A", "answer": answer,
                 "correct": answer == "A", "wall_seconds": i + 1, "status": "ok"}
                for i, answer in enumerate(["A", "B", "B"])]
        other = [dict(r) for r in rows]
        other[0].update(answer="C", correct=False)
        other[1].update(answer="A", correct=True)
        pa, pb = self.root / "a.jsonl", self.root / "b.jsonl"
        jsonl(pa, rows)
        jsonl(pb, other)
        c = compare(pa, pb, samples=50)
        self.assertEqual(c["difference_percentage_points"], 0)
        self.assertEqual(c["fixed"], [["1", "eng"]])
        self.assertEqual(c["regressions"], [["0", "eng"]])
        jsonl(pb, list(reversed(other)))
        with self.assertRaisesRegex(ValueError, "ordering"):
            compare(pa, pb)
        s = summarize(rows)
        self.assertEqual(s["confusion_matrix"]["A"]["B"], 2)
        self.assertEqual(s["review_categories"], {"unreviewed": 2})
        self.assertEqual(percentile([1, 2, 3], .95), 3)


if __name__ == "__main__":
    unittest.main()
