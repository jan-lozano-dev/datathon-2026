"""Match a value printed by a program to exactly one answer option.

Precision matters more than coverage here: a wrong match is a wrong answer,
while no match only sends the problem to the fallback. So a value is accepted
only when it equals one option and no other.
"""
import re
from fractions import Fraction

LETTERS = "ABCDE"

# Minus signs and the dash-like characters OCR produces for them
_DASHES = dict.fromkeys(map(ord, "−–—‒－一ー"), "-")
_VALUE = re.compile(r"^(?P<num>[-+]?\s*\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?)\s*(?P<unit>[^\d\s][^\d]*)?$")
_TIME = re.compile(r"^(\d{1,2})\s*[:h]\s*(\d{2})(?::\d{2})?$")
_UNIT_POWER = re.compile(r"\b(mm|cm|dm|km|m)\s*[23²³]")
_THOUSANDS = re.compile(r"[-+]?\d{1,3}(?:,\d{3})+")
_ARTICLE = re.compile(r"^(?:En|Na|L['’]|El|La|The)\s*(?=[A-ZÀ-Ý])")
_CLOSE = Fraction(1, 10 ** 6)


def _decimal(text):
    if _THOUSANDS.fullmatch(text):
        text = text.replace(",", "")
    try:
        return Fraction(text.replace(",", "."))
    except (ValueError, ZeroDivisionError):
        return None


def _number(text):
    text = text.replace(" ", "")
    if "/" not in text:
        return _decimal(text)
    top, bottom = (_decimal(part) for part in text.split("/", 1))
    if top is None or not bottom:
        return None
    return top / bottom


def _word(text):
    """A key for names and words that survives OCR confusions such as l/I/1."""
    text = _ARTICLE.sub("", text).lower()
    text = text.replace("1", "l").replace("i", "l").replace("|", "l").replace("0", "o")
    return re.sub(r"[\W_]+", "", text)


def keys(text, ocr=True):
    """Every way to read one string as a value: {("num", Fraction), ("time", minutes), ("text", key)}.

    ocr=True is for option strings, which come from OCR and carry its noise.
    A program's own output is read strictly: "4 9" is two numbers, not 9.
    """
    text = str(text).translate(_DASHES).strip().strip(".;").strip()
    if not text:
        return set()
    if ocr and re.fullmatch(r"[-+]?[\dOo]+", text):
        text = re.sub("[Oo]", "0", text)  # OCR reads a lone zero as the letter O
    match = _TIME.match(text)
    if match:
        return {("time", int(match.group(1)) * 60 + int(match.group(2)))}
    found = set()
    match = _VALUE.match(_UNIT_POWER.sub(r"\1", text.lstrip("€$£ ")))
    if match:
        value = _number(match.group("num"))
        if value is not None:
            found.add(("num", value))
    parts = text.split()
    several = len(parts) > 1 and all(re.fullmatch(r"\d+", part) for part in parts)
    if several and ocr:
        found.add(("num", Fraction("".join(parts))))  # "10 000"
        if not parts[-1].startswith("0"):
            found.add(("num", Fraction(parts[-1])))   # "4 456": a stray digit before 456
    if several and not ocr:
        return set()  # a program that prints several numbers gave no single answer
    if not found:
        word = _word(text)
        if word:
            found.add(("text", word))
    return found


def output_keys(output):
    """Read the last line a program printed."""
    lines = [line.strip() for line in str(output).splitlines() if line.strip()]
    if not lines:
        return set()
    line = lines[-1]
    if line in ("True", "False", "None"):
        return set()
    while len(line) > 1 and line[0] in "[({'\"" and line[-1] in "])}'\",":
        line = line[1:-1].strip().rstrip(",").strip()
    candidates = [line]
    for separator in ("=", ": "):
        if separator in line:
            candidates.append(line.rsplit(separator, 1)[1].strip())
    for candidate in candidates:
        found = keys(candidate, ocr=False)
        if any(kind != "text" for kind, _value in found):
            return found
    return keys(line, ocr=False)


def _same(a, b):
    if a[0] != b[0]:
        return False
    if a[0] == "num":  # a float such as 0.3333333333333333 still means 1/3
        return abs(a[1] - b[1]) <= _CLOSE * max(1, abs(b[1]))
    return a[1] == b[1]


def match(output, options):
    """Return the letter of the only option equal to the program's output, or None."""
    printed = output_keys(output)
    if not printed:
        return None
    hits = [letter for letter in LETTERS if letter in options
            and any(_same(p, o) for p in printed for o in keys(options[letter]))]
    return hits[0] if len(hits) == 1 else None
