#!/usr/bin/env python3
"""Write our own Kangaroo-style development problems, in English and Catalan.

    python3 experiments/synthetic_dev.py        # writes data/dev_synth.jsonl

The final test looks like the organizers' practice set (short, text-only,
numeric options) much more than like M3Kang. Tuning prompts on the practice
set itself would overfit its 50 problems, so these 40 problems are written
from scratch, in the same style, to tune on instead. Every answer is computed
by the small check next to it, so no label is typed by hand.
"""
import itertools
import json
import math
import os
import sys
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from copilot import options as option_match  # noqa: E402


def fib_like(n):
    a, b = 2, 5
    for _ in range(n - 2):
        a, b = b, a + b
    return b


def divisors(n):
    return [d for d in range(1, n + 1) if n % d == 0]


# (level, English, Catalan, options, Catalan options or None, check)
PROBLEMS = [
    (0, "How many whole numbers from 1 to 60 are multiples of 4 or multiples of 6?",
     "Quants nombres enters de l'1 al 60 són múltiples de 4 o múltiples de 6?",
     ["20", "24", "25", "30", "35"], None,
     lambda: sum(1 for n in range(1, 61) if n % 4 == 0 or n % 6 == 0)),
    (0, "Pau has 3 more marbles than Laia. Together they have 21 marbles. How many marbles does Pau have?",
     "En Pau té 3 bales més que la Laia. Entre tots dos tenen 21 bales. Quantes bales té en Pau?",
     ["9", "12", "15", "18", "24"], None,
     lambda: next(p for p in range(22) if p + (p - 3) == 21)),
    (0, "What is the sum of the digits of the number 2026 × 5?",
     "Quina és la suma de les xifres del nombre 2026 × 5?",
     ["3", "4", "5", "8", "10"], None,
     lambda: sum(int(c) for c in str(2026 * 5))),
    (0, "A train leaves at 9:50 and the journey takes 2 hours and 35 minutes. At what time does it arrive?",
     "Un tren surt a les 9:50 i el viatge dura 2 hores i 35 minuts. A quina hora arriba?",
     ["12:25", "12:35", "12:45", "13:15", "13:25"], None,
     lambda: "%d:%02d" % divmod(9 * 60 + 50 + 2 * 60 + 35, 60)),
    (0, "Carla is taller than Dani but shorter than Emma. Ferran is taller than Emma. "
        "Gina is shorter than Dani. Who is the second tallest?",
     "La Carla és més alta que en Dani però més baixa que l'Emma. En Ferran és més alt que l'Emma. "
     "La Gina és més baixa que en Dani. Qui és el segon més alt?",
     ["Carla", "Emma", "Dani", "Ferran", "Gina"], None,
     lambda: next(order[1] for order in itertools.permutations(["Carla", "Dani", "Emma", "Ferran", "Gina"])
                  if order.index("Carla") < order.index("Dani") and order.index("Emma") < order.index("Carla")
                  and order.index("Ferran") < order.index("Emma") and order.index("Dani") < order.index("Gina"))),
    (1, "How many two-digit numbers have digits that add up to 9?",
     "Quants nombres de dues xifres tenen xifres que sumen 9?",
     ["6", "7", "8", "9", "10"], None,
     lambda: sum(1 for n in range(10, 100) if n // 10 + n % 10 == 9)),
    (1, "A clock strikes once at 1 o'clock, twice at 2 o'clock, and so on, up to 12 times at 12 o'clock. "
        "How many times does it strike in 24 hours?",
     "Un rellotge toca una campanada a la 1, dues a les 2, i així successivament fins a 12 campanades a les 12. "
     "Quantes campanades toca en 24 hores?",
     ["78", "90", "144", "150", "156"], None,
     lambda: 2 * sum(range(1, 13))),
    (1, "The product of two whole numbers is 36 and their sum is 13. What is their difference?",
     "El producte de dos nombres enters és 36 i la seva suma és 13. Quina és la seva diferència?",
     ["5", "7", "9", "13", "16"], None,
     lambda: next(b - a for a in range(1, 37) for b in range(a, 37) if a * b == 36 and a + b == 13)),
    (1, "Maria buys 3 pens and 2 notebooks for 12 euros. A notebook costs 1 euro more than a pen. "
        "How many euros does a notebook cost?",
     "La Maria compra 3 bolígrafs i 2 llibretes per 12 euros. Una llibreta costa 1 euro més que un bolígraf. "
     "Quants euros costa una llibreta?",
     ["1", "2", "3", "4", "5"], None,
     lambda: next(p + 1 for p in range(13) if 3 * p + 2 * (p + 1) == 12)),
    (1, "A rectangle has a perimeter of 30 cm and its length is twice its width. What is its area, in cm²?",
     "Un rectangle té un perímetre de 30 cm i la seva llargada és el doble de la seva amplada. "
     "Quina és la seva àrea, en cm²?",
     ["25", "36", "48", "50", "100"], None,
     lambda: next(w * 2 * w for w in range(1, 16) if 2 * (w + 2 * w) == 30)),
    (2, "How many whole numbers from 100 to 199 have three different digits?",
     "Quants nombres enters del 100 al 199 tenen les tres xifres diferents?",
     ["64", "72", "80", "81", "90"], None,
     lambda: sum(1 for n in range(100, 200) if len(set(str(n))) == 3)),
    (2, "What is the remainder when 3^100 is divided by 7?",
     "Quin és el residu de dividir 3^100 entre 7?",
     ["1", "2", "4", "5", "6"], None,
     lambda: pow(3, 100, 7)),
    (2, "In a class of 28 students, there are 4 more girls than boys. How many boys are there?",
     "En una classe de 28 alumnes hi ha 4 noies més que nois. Quants nois hi ha?",
     ["8", "10", "11", "12", "16"], None,
     lambda: next(b for b in range(29) if b + b + 4 == 28)),
    (2, "How many multiples of 7 are there between 100 and 300?",
     "Quants múltiples de 7 hi ha entre 100 i 300?",
     ["20", "25", "26", "27", "28"], None,
     lambda: sum(1 for n in range(101, 300) if n % 7 == 0)),
    (2, "Today is Wednesday. What day of the week will it be in 100 days?",
     "Avui és dimecres. Quin dia de la setmana serà d'aquí a 100 dies?",
     ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
     ["dilluns", "dimarts", "dimecres", "dijous", "divendres"],
     lambda: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][(2 + 100) % 7]),
    (2, "Grandma is 6 times as old as Nil. In 4 years she will be 5 times as old as Nil. How old is Nil now?",
     "L'àvia té 6 vegades l'edat d'en Nil. D'aquí a 4 anys tindrà 5 vegades l'edat d'en Nil. "
     "Quants anys té en Nil ara?",
     ["10", "12", "14", "16", "18"], None,
     lambda: next(n for n in range(1, 60) if 6 * n + 4 == 5 * (n + 4))),
    (3, "How many positive divisors does 360 have?",
     "Quants divisors positius té el 360?",
     ["24", "30", "36", "48", "72"], None,
     lambda: len(divisors(360))),
    (3, "In how many ways can three different numbers be chosen from 1, 2, 3, 4, 5, 6, 7, 8 so that their sum is 12? "
        "(The order does not matter.)",
     "De quantes maneres es poden triar tres nombres diferents d'entre 1, 2, 3, 4, 5, 6, 7, 8 de manera que sumin 12? "
     "(L'ordre no importa.)",
     ["5", "6", "7", "8", "10"], None,
     lambda: sum(1 for c in itertools.combinations(range(1, 9), 3) if sum(c) == 12)),
    (3, "How many two-digit numbers are divisible by the sum of their digits?",
     "Quants nombres de dues xifres són divisibles per la suma de les seves xifres?",
     ["18", "21", "23", "25", "27"], None,
     lambda: sum(1 for n in range(10, 100) if n % (n // 10 + n % 10) == 0)),
    (3, "The sum of five consecutive whole numbers is 2025. What is the largest of them?",
     "La suma de cinc nombres enters consecutius és 2025. Quin és el més gran?",
     ["403", "405", "406", "407", "409"], None,
     lambda: next(n + 4 for n in range(1, 2026) if sum(range(n, n + 5)) == 2025)),
    (3, "A farmer has hens and rabbits. Together they have 35 heads and 94 legs. How many rabbits are there?",
     "Un pagès té gallines i conills. En total tenen 35 caps i 94 potes. Quants conills hi ha?",
     ["12", "15", "18", "20", "23"], None,
     lambda: next(r for r in range(36) if 4 * r + 2 * (35 - r) == 94)),
    (3, "A shop sells pencils only in packs of 4 and packs of 7. "
        "What is the largest number of pencils that cannot be bought exactly?",
     "Una botiga ven llapis només en paquets de 4 i en paquets de 7. "
     "Quin és el nombre més gran de llapis que no es pot comprar exactament?",
     ["11", "13", "15", "16", "17"], None,
     lambda: max(n for n in range(1, 100) if not any((n - 4 * a) % 7 == 0 for a in range(n // 4 + 1)))),
    (4, "How many whole numbers from 1 to 1000 are perfect squares or perfect cubes?",
     "Quants nombres enters de l'1 al 1000 són quadrats perfectes o cubs perfectes?",
     ["31", "34", "36", "37", "38"], None,
     lambda: len({n * n for n in range(1, 32)} | {n ** 3 for n in range(1, 11)})),
    (4, "What is the smallest positive whole number that has exactly 10 positive divisors?",
     "Quin és el nombre enter positiu més petit que té exactament 10 divisors positius?",
     ["48", "64", "80", "162", "512"], None,
     lambda: next(n for n in range(1, 1000) if len(divisors(n)) == 10)),
    (4, "The two digits of a two-digit number are swapped, and the new number is 27 more than the original. "
        "How many two-digit numbers have this property?",
     "S'intercanvien les dues xifres d'un nombre de dues xifres, i el nombre nou és 27 unitats més gran "
     "que l'original. Quants nombres de dues xifres tenen aquesta propietat?",
     ["5", "6", "7", "8", "9"], None,
     lambda: sum(1 for n in range(10, 100) if int(str(n)[::-1]) == n + 27)),
    (4, "How many pairs of positive whole numbers (a, b) with a ≤ b satisfy a × b = 144?",
     "Quantes parelles de nombres enters positius (a, b) amb a ≤ b compleixen a × b = 144?",
     ["6", "7", "8", "12", "15"], None,
     lambda: sum(1 for a in range(1, 145) for b in range(a, 145) if a * b == 144)),
    (4, "The average of five numbers is 12. When a sixth number is added, the average becomes 13. "
        "What is the sixth number?",
     "La mitjana de cinc nombres és 12. Quan s'hi afegeix un sisè nombre, la mitjana passa a ser 13. "
     "Quin és el sisè nombre?",
     ["14", "18", "20", "24", "25"], None,
     lambda: 13 * 6 - 12 * 5),
    (5, "For how many integers x is |2x − 5| < 9?",
     "Per a quants nombres enters x es compleix |2x − 5| < 9?",
     ["5", "6", "7", "8", "9"], None,
     lambda: sum(1 for x in range(-100, 101) if abs(2 * x - 5) < 9)),
    (5, "Two fair dice are rolled. What is the probability that the product of the two numbers is a multiple of 6?",
     "Es llancen dos daus equilibrats. Quina és la probabilitat que el producte dels dos nombres sigui "
     "múltiple de 6?",
     ["1/6", "1/4", "1/3", "7/18", "5/12"], None,
     lambda: Fraction(sum(1 for a in range(1, 7) for b in range(1, 7) if a * b % 6 == 0), 36)),
    (5, "A four-digit palindrome reads the same forwards and backwards, like 2552. "
        "How many four-digit palindromes are divisible by 9?",
     "Un capicua de quatre xifres es llegeix igual d'esquerra a dreta que de dreta a esquerra, com 2552. "
     "Quants capicues de quatre xifres són divisibles per 9?",
     ["10", "11", "12", "18", "20"], None,
     lambda: sum(1 for n in range(1000, 10000) if str(n) == str(n)[::-1] and n % 9 == 0)),
    (5, "A sequence starts with 2 and 5, and each following term is the sum of the two previous terms: "
        "2, 5, 7, 12, ... What is the last digit of the 20th term?",
     "Una successió comença amb 2 i 5, i cada terme següent és la suma dels dos anteriors: "
     "2, 5, 7, 12, ... Quina és l'última xifra del terme número 20?",
     ["1", "3", "5", "7", "9"], None,
     lambda: fib_like(20) % 10),
    (5, "A car travels 120 km at 60 km/h and then another 120 km at 40 km/h. "
        "What is its average speed for the whole trip, in km/h?",
     "Un cotxe recorre 120 km a 60 km/h i després 120 km més a 40 km/h. "
     "Quina és la seva velocitat mitjana en tot el trajecte, en km/h?",
     ["45", "46", "48", "50", "52"], None,
     lambda: Fraction(240, 1) / (Fraction(120, 60) + Fraction(120, 40))),
    (6, "How many positive whole numbers less than 1000 have digits that add up to 5?",
     "Quants nombres enters positius més petits que 1000 tenen xifres que sumen 5?",
     ["15", "18", "21", "24", "28"], None,
     lambda: sum(1 for n in range(1, 1000) if sum(int(c) for c in str(n)) == 5)),
    (6, "What is the sum of all the positive divisors of 496 that are smaller than 496?",
     "Quina és la suma de tots els divisors positius de 496 que són més petits que 496?",
     ["248", "372", "480", "496", "992"], None,
     lambda: sum(divisors(496)) - 496),
    (6, "A fair coin is tossed 5 times. What is the probability of getting exactly 3 heads?",
     "Es llança una moneda equilibrada 5 vegades. Quina és la probabilitat que surtin exactament 3 cares?",
     ["1/16", "1/8", "3/16", "1/4", "5/16"], None,
     lambda: Fraction(math.comb(5, 3), 32)),
    (6, "For how many whole numbers n from 1 to 100 is n³ − n divisible by 24?",
     "Per a quants nombres enters n de l'1 al 100 és n³ − n divisible per 24?",
     ["62", "66", "70", "75", "83"], None,
     lambda: sum(1 for n in range(1, 101) if (n ** 3 - n) % 24 == 0)),
    (7, "How many subsets of {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, including the empty set, "
        "contain no two consecutive numbers?",
     "Quants subconjunts de {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, comptant el conjunt buit, "
     "no contenen cap parell de nombres consecutius?",
     ["89", "144", "233", "256", "512"], None,
     lambda: sum(1 for mask in range(1 << 10) if not mask & (mask << 1))),
    (7, "What are the last two digits of 7^2025?",
     "Quines són les dues últimes xifres de 7^2025?",
     ["01", "03", "07", "43", "49"], None,
     lambda: pow(7, 2025, 100)),
    (7, "How many ordered triples (a, b, c) of positive whole numbers satisfy a + b + c = 10?",
     "Quantes ternes ordenades (a, b, c) de nombres enters positius compleixen a + b + c = 10?",
     ["21", "28", "30", "36", "45"], None,
     lambda: sum(1 for a in range(1, 10) for b in range(1, 10) for c in range(1, 10) if a + b + c == 10)),
    (7, "The sum of the squares of three consecutive positive whole numbers is 365. "
        "What is the largest of the three numbers?",
     "La suma dels quadrats de tres nombres enters positius consecutius és 365. "
     "Quin és el més gran dels tres nombres?",
     ["8", "9", "10", "11", "12"], None,
     lambda: next(n + 2 for n in range(1, 50) if n * n + (n + 1) ** 2 + (n + 2) ** 2 == 365)),
]


def main():
    rows = []
    for number, (level, english, catalan, choices, catalan_choices, check) in enumerate(PROBLEMS, 1):
        options = dict(zip("ABCDE", choices))
        label = option_match.match(str(check()), options)
        if label is None:
            sys.exit(f"problem {number}: the computed answer {check()!r} is not exactly one of {choices}")
        for language, text, shown in (("eng", english, choices), ("cat", catalan, catalan_choices or choices)):
            rows.append({"id": f"lvl-{level}_synth_{number}", "language": language, "level": level,
                         "year": 2026, "text_only": True, "text": f"{number}. {text}",
                         "options": dict(zip("ABCDE", shown)), "label": label})
    path = "data/dev_synth.jsonl"
    with open(path, "w", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    labels = sorted((label, sum(r["label"] == label for r in rows)) for label in "ABCDE")
    print(f"{path}: {len(rows)} rows, {len(PROBLEMS)} problems, labels {labels}")


if __name__ == "__main__":
    main()
