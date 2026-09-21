"""Basic strategy: one verified base chart plus rule deltas.

Source of truth for the base chart and the H17 delta set:
Wizard of Odds, "4-Deck to 8-Deck Blackjack Strategy" (text form, dealer
stands on soft 17, surrender allowed), https://wizardofodds.com/games/blackjack/strategy/4-decks/

The base chart below is 4-8 decks / S17 / DAS / late surrender. Every other
supported rule is expressed as a small patch over it. Do not edit cells by
hand without re-checking them against the published chart; tests/test_strategy.py
asserts the whole table against the published rule text.

Action codes stored in the chart:
    H   hit
    S   stand
    D   double, else hit
    DS  double, else stand
    P   split
    PH  split if DAS allowed, else hit   (resolved away by resolve())
Surrender is held separately because it only applies to the first two cards.
"""

from typing import Any

UPCARDS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"]

# Decks the shipped chart is verified for. Single- and double-deck games need
# their own published chart; they are deliberately not offered rather than
# approximated from this one.
SUPPORTED_DECKS = [4, 6, 8]


def _row(spec: dict[str, str], default: str) -> list[str]:
    """Build a 10-cell row from {upcard: action} plus a default for the rest."""
    return [spec.get(u, default) for u in UPCARDS]


# --- Base chart: 4-8 decks, S17, DAS, late surrender -----------------------

BASE_HARD: dict[int, list[str]] = {
    4: _row({}, "H"),
    5: _row({}, "H"),
    6: _row({}, "H"),
    7: _row({}, "H"),
    8: _row({}, "H"),
    # Double hard 9 vs 3-6.
    9: _row({"3": "D", "4": "D", "5": "D", "6": "D"}, "H"),
    # Double hard 10 except against 10 or A.
    10: _row({"10": "H", "A": "H"}, "D"),
    # Double hard 11 except against A.
    11: _row({"A": "H"}, "D"),
    # Stand on hard 12 against 4-6, otherwise hit.
    12: _row({"4": "S", "5": "S", "6": "S"}, "H"),
    # Stand on hard 13-16 against 2-6, otherwise hit.
    13: _row({"2": "S", "3": "S", "4": "S", "5": "S", "6": "S"}, "H"),
    14: _row({"2": "S", "3": "S", "4": "S", "5": "S", "6": "S"}, "H"),
    15: _row({"2": "S", "3": "S", "4": "S", "5": "S", "6": "S"}, "H"),
    16: _row({"2": "S", "3": "S", "4": "S", "5": "S", "6": "S"}, "H"),
    # Always stand on hard 17 or more.
    17: _row({}, "S"),
    18: _row({}, "S"),
    19: _row({}, "S"),
    20: _row({}, "S"),
    21: _row({}, "S"),
}

BASE_SOFT: dict[int, list[str]] = {
    # A,A that cannot be split. Hit (drawing-to-split-aces edge case ignored).
    12: _row({}, "H"),
    # Double soft 13 or 14 vs 5-6.
    13: _row({"5": "D", "6": "D"}, "H"),
    14: _row({"5": "D", "6": "D"}, "H"),
    # Double soft 15 or 16 vs 4-6.
    15: _row({"4": "D", "5": "D", "6": "D"}, "H"),
    16: _row({"4": "D", "5": "D", "6": "D"}, "H"),
    # Double soft 17 vs 3-6, otherwise hit.
    17: _row({"3": "D", "4": "D", "5": "D", "6": "D"}, "H"),
    # Double soft 18 vs 3-6; stand otherwise except hit vs 9, 10, A.
    18: _row(
        {"3": "DS", "4": "DS", "5": "DS", "6": "DS", "9": "H", "10": "H", "A": "H"},
        "S",
    ),
    # Always stand on soft 19 or more.
    19: _row({}, "S"),
    20: _row({}, "S"),
    21: _row({}, "S"),
}

BASE_PAIR: dict[str, list[str]] = {
    # Always split aces and 8s.
    "A": _row({}, "P"),
    "8": _row({}, "P"),
    # Split 2s and 3s against 4-7, and against 2 or 3 if DAS is allowed.
    "2": _row({"2": "PH", "3": "PH", "4": "P", "5": "P", "6": "P", "7": "P"}, "H"),
    "3": _row({"2": "PH", "3": "PH", "4": "P", "5": "P", "6": "P", "7": "P"}, "H"),
    # Split 4s only if DAS is allowed and the dealer shows a 5 or 6.
    "4": _row({"5": "PH", "6": "PH"}, "H"),
    # Never split 5s: play as hard 10.
    "5": _row({"10": "H", "A": "H"}, "D"),
    # Split 6s against 3-6, and against 2 if DAS is allowed.
    "6": _row({"2": "PH", "3": "P", "4": "P", "5": "P", "6": "P"}, "H"),
    # Split 7s against 2-7.
    "7": _row({"2": "P", "3": "P", "4": "P", "5": "P", "6": "P", "7": "P"}, "H"),
    # Split 9s against 2-6 or 8-9.
    "9": _row(
        {"2": "P", "3": "P", "4": "P", "5": "P", "6": "P", "8": "P", "9": "P"}, "S"
    ),
    # Never split 10s: play as hard 20.
    "10": _row({}, "S"),
}

# Surrender hard 16 (but not a pair of 8s) vs 9, 10 or A, and hard 15 vs 10.
# Keyed "hard:<total>" or "pair:<rank>" so a pair of 8s is addressable on its
# own and never picked up by the hard-16 entry.
BASE_SURRENDER: dict[str, list[str]] = {
    "hard:15": ["10"],
    "hard:16": ["9", "10", "A"],
}


# --- Rule deltas -----------------------------------------------------------
#
# Each delta is a patch over the base. "chart" patches one cell, "surrender"
# adds one upcard to a surrender entry.

# Dealer hits soft 17. Published as exactly four changes:
#   Surrender 15, a pair of 8s, and 17 vs dealer A.
#   Double 11 vs dealer A. Double soft 18 vs 2. Double soft 19 vs 6.
DELTA_H17: list[dict[str, Any]] = [
    {"kind": "chart", "group": "hard", "key": 11, "up": "A", "action": "D"},
    {"kind": "chart", "group": "soft", "key": 18, "up": "2", "action": "DS"},
    {"kind": "chart", "group": "soft", "key": 19, "up": "6", "action": "DS"},
    {"kind": "surrender", "key": "hard:15", "up": "A"},
    {"kind": "surrender", "key": "hard:17", "up": "A"},
    {"kind": "surrender", "key": "pair:8", "up": "A"},
]

DELTA_SETS: dict[str, list[dict[str, Any]]] = {
    "h17": DELTA_H17,
}


DEFAULT_RULES: dict[str, Any] = {
    "decks": 6,
    "h17": False,
    "das": True,
    "surrender": True,
    "peek": True,
    "resplit_limit": 4,  # max total hands from one split
    "resplit_aces": False,
    "double_any_two": True,  # False restricts doubling to hard 9, 10, 11
    "blackjack_pays": 1.5,
    "penetration": 0.75,
    "other_players": 2,
}


def _clone(chart: dict) -> dict:
    return {k: list(v) for k, v in chart.items()}


def active_deltas(rules: dict[str, Any]) -> list[str]:
    """Names of the delta sets that apply to these rules."""
    names = []
    if rules.get("h17"):
        names.append("h17")
    return names


def resolve(rules: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve the base chart plus active deltas into a concrete chart.

    The returned chart contains no rule-conditional codes: PH is already
    collapsed to P or H using the DAS flag, and the surrender map is empty
    when the game does not offer surrender. D and DS survive because whether
    a double is legal depends on the hand, not the rules, and is decided at
    decision time by the client.
    """
    r = dict(DEFAULT_RULES)
    r.update(rules or {})

    hard = _clone(BASE_HARD)
    soft = _clone(BASE_SOFT)
    pair = _clone(BASE_PAIR)
    surrender = {k: list(v) for k, v in BASE_SURRENDER.items()}

    groups = {"hard": hard, "soft": soft, "pair": pair}

    for name in active_deltas(r):
        for d in DELTA_SETS[name]:
            if d["kind"] == "chart":
                group = groups[d["group"]]
                group[d["key"]][UPCARDS.index(d["up"])] = d["action"]
            elif d["kind"] == "surrender":
                surrender.setdefault(d["key"], [])
                if d["up"] not in surrender[d["key"]]:
                    surrender[d["key"]].append(d["up"])

    # Collapse DAS-conditional split cells.
    das = bool(r["das"])
    for row in pair.values():
        for i, code in enumerate(row):
            if code == "PH":
                row[i] = "P" if das else "H"

    # Doubling restricted to hard 9/10/11 removes every soft double.
    if not r.get("double_any_two", True):
        for total, row in soft.items():
            for i, code in enumerate(row):
                if code == "D":
                    row[i] = "H"
                elif code == "DS":
                    row[i] = "S"

    if not r.get("surrender", True):
        surrender = {}

    return {
        "upcards": UPCARDS,
        "hard": {str(k): v for k, v in hard.items()},
        "soft": {str(k): v for k, v in soft.items()},
        "pair": pair,
        "surrender": surrender,
        "rules": r,
        "deltas": active_deltas(r),
    }


def lookup(chart: dict[str, Any], group: str, key: Any, upcard: str) -> str:
    """Read one cell out of a resolved chart."""
    return chart[group][str(key)][UPCARDS.index(upcard)]
