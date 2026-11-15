"""Checks for the parts of Reason that need no model: python3 -m unittest tests.test_reason"""
import unittest

from copilot import options, pot, sandbox

NUMBERS = {"A": "18", "B": "20", "C": "24", "D": "27", "E": "36"}


class MatchOptions(unittest.TestCase):
    def test_integer(self):
        self.assertEqual(options.match("24\n", NUMBERS), "C")
        self.assertEqual(options.match("24.0", NUMBERS), "C")
        self.assertIsNone(options.match("25", NUMBERS))

    def test_last_line_and_labels(self):
        self.assertEqual(options.match("checking...\nAnswer: 27\n", NUMBERS), "D")
        self.assertEqual(options.match("x = 36", NUMBERS), "E")
        self.assertEqual(options.match("[18]", NUMBERS), "A")

    def test_no_output_or_boolean(self):
        self.assertIsNone(options.match("", NUMBERS))
        self.assertIsNone(options.match("True", NUMBERS))

    def test_fractions_and_floats(self):
        fractions = {"A": "1/10", "B": "3/20", "C": "1/5", "D": "1/4", "E": "1/2"}
        self.assertEqual(options.match("0.2", fractions), "C")
        self.assertEqual(options.match("1/4", fractions), "D")
        self.assertEqual(options.match("0.15000000000000002", fractions), "B")
        thirds = {"A": "-1/3", "B": "0", "C": "1/4", "D": "1/3", "E": "1"}
        self.assertEqual(options.match("0.3333333333333333", thirds), "D")
        self.assertEqual(options.match("-0.3333333333333333", thirds), "A")

    def test_units_and_ocr_noise(self):
        self.assertEqual(options.match("13", {"A": "9 km", "B": "11 km", "C": "12km", "D": "13km", "E": "14km"}), "D")
        self.assertEqual(options.match("115", {"A": "75°", "B": "100°", "C": "105°", "D": "115 °", "E": "120°"}), "D")
        self.assertEqual(options.match("0", {"A": "O", "B": "3", "C": "5", "D": "7", "E": "9"}), "A")
        self.assertEqual(options.match("-3", {"A": "一3", "B": "一2", "C": "-1", "D": "1", "E": "2"}), "A")
        self.assertEqual(options.match("456", {"A": "258", "B": "285", "C": "358", "D": "4 456", "E": "1358"}), "D")
        self.assertEqual(options.match("3,5", {"A": "2.5", "B": "3.5", "C": "4", "D": "5", "E": "6"}), "B")

    def test_times_and_names(self):
        times = {"A": "8:45", "B": "8:55", "C": "9:00", "D": "9:05", "E": "9:10"}
        self.assertEqual(options.match("09:10", times), "E")
        self.assertEqual(options.match("9:10:00", times), "E")
        names = {"A": "Jan", "B": "Marc", "C": "Nil", "D": "LIuC", "E": "Oriol"}
        self.assertEqual(options.match("Lluc", names), "D")
        catalan = {"A": "EnJan", "B": "En Marc", "C": "En Nil", "D": "En Lluc", "E": "L'Oriol"}
        self.assertEqual(options.match("Jan", catalan), "A")
        self.assertEqual(options.match("Oriol", catalan), "E")

    def test_two_equal_options_abstain(self):
        self.assertIsNone(options.match("5", {"A": "5", "B": "5", "C": "6", "D": "7", "E": "8"}))

    def test_pairs_are_not_numbers(self):
        pairs = {"A": "2 and 3", "B": "2 and 5", "C": "3 and 5", "D": "4 and 5", "E": "5 and 6"}
        self.assertIsNone(options.match("2", pairs))

    def test_several_printed_numbers_are_no_answer(self):
        self.assertIsNone(options.match("4 9", {"A": "5", "B": "7", "C": "9", "D": "13", "E": "16"}))
        self.assertIsNone(options.match("4 456", {"A": "258", "B": "285", "C": "358", "D": "456", "E": "1358"}))


class Sandbox(unittest.TestCase):
    def test_runs_and_prints(self):
        output, error = sandbox.run("print(sum(1 for n in range(1, 101) if '7' in str(n)))", 5)
        self.assertEqual((output.strip(), error), ("19", ""))

    def test_allowed_import(self):
        self.assertIsNone(sandbox.check("from itertools import permutations\nprint(len(list(permutations('abc'))))"))

    def test_rejects(self):
        for code in ("import os", "import subprocess as s", "from os import path", "open('x')",
                     "__import__('os')", "print(().__class__)", "eval('1')", "def f(:"):
            self.assertIsNotNone(sandbox.check(code), code)

    def test_stops_endless_loop(self):
        output, error = sandbox.run("while True:\n    pass", 1)
        self.assertEqual(error, "timeout")

    def test_reports_crash(self):
        output, error = sandbox.run("print(1/0)", 5)
        self.assertTrue(error.startswith("runtime"))


class Programs(unittest.TestCase):
    def test_worked_examples_are_right(self):
        for text, choices, program, letter in pot.EXAMPLES:
            self.assertIsNone(sandbox.check(program), text)
            output, error = sandbox.run(program, 5)
            self.assertEqual(error, "", text)
            self.assertEqual(options.match(output, dict(zip("ABCDE", choices))), letter, text)

    def test_extract_code(self):
        fence = pot.FENCE
        self.assertEqual(pot.extract_code(f"{fence}python\nprint(1)\n{fence}\nDone."), "print(1)")
        self.assertEqual(pot.extract_code(f"{fence}python\nprint(1)\nprint(2"), "print(1)\nprint(2")
        self.assertEqual(pot.extract_code("print(3)\n"), "print(3)")

    def test_repair_adds_print(self):
        code = pot.repair("def solve():\n    return 6\n\nsolve()")
        self.assertEqual(sandbox.run(code, 5)[0].strip(), "6")
        code = pot.repair("def solve():\n    return 7")
        self.assertEqual(sandbox.run(code, 5)[0].strip(), "7")
        code = pot.repair("total = 2 + 3")
        self.assertEqual(sandbox.run(code, 5)[0].strip(), "5")

    def test_repair_leaves_working_code(self):
        for code in ("print(4)", "def f():\n    print(8)\n\nf()", "def f():\n    return 8\n\nprint(f())"):
            self.assertEqual(pot.repair(code), code)

    def test_repair_calls_forgotten_function(self):
        code = pot.repair("def f():\n    print(9)")
        self.assertEqual(sandbox.run(code, 5)[0].strip(), "9")

    def test_repair_drops_cut_line(self):
        code = pot.repair("x = 3\nprint(x)\nfor i in range(")
        self.assertEqual(sandbox.run(code, 5)[0].strip(), "3")


if __name__ == "__main__":
    unittest.main()
