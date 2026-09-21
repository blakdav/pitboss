"""Counting systems as data.

Each system is tag values per rank plus a few properties. Adding a system is
a dict entry, never code. Level is the largest absolute tag value; balanced
means the tags sum to zero across a full deck.

Hi-Lo is the reference system: it is the default, and the published
Illustrious 18 / Fab 4 deviation indices are keyed to it.
"""

RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"]


def _tags(values: dict[str, float]) -> dict[str, float]:
    return {r: values.get(r, 0) for r in RANKS}


SYSTEMS: dict[str, dict] = {
    "hi_lo": {
        "name": "Hi-Lo",
        "level": 1,
        "balanced": True,
        "irc": 0,
        "ace_side_count": False,
        "tags": _tags(
            {"2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "10": -1, "A": -1}
        ),
    },
    "ko": {
        "name": "KO (Knock-Out)",
        "level": 1,
        "balanced": False,
        # Unbalanced: the initial running count depends on deck count.
        # IRC = 4 - 4 * decks, applied at shoe start.
        "irc_formula": "4 - 4 * decks",
        "irc": None,
        "ace_side_count": False,
        "tags": _tags(
            {"2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "10": -1, "A": -1}
        ),
    },
    "hi_opt_i": {
        "name": "Hi-Opt I",
        "level": 1,
        "balanced": True,
        "irc": 0,
        "ace_side_count": True,
        "tags": _tags({"3": 1, "4": 1, "5": 1, "6": 1, "10": -1}),
    },
    "hi_opt_ii": {
        "name": "Hi-Opt II",
        "level": 2,
        "balanced": True,
        "irc": 0,
        "ace_side_count": True,
        "tags": _tags(
            {"2": 1, "3": 1, "4": 2, "5": 2, "6": 1, "7": 1, "10": -2}
        ),
    },
    "omega_ii": {
        "name": "Omega II",
        "level": 2,
        "balanced": True,
        "irc": 0,
        "ace_side_count": True,
        "tags": _tags(
            {"2": 1, "3": 1, "4": 2, "5": 2, "6": 2, "7": 1, "9": -1, "10": -2}
        ),
    },
    "zen": {
        "name": "Zen Count",
        "level": 2,
        "balanced": True,
        "irc": 0,
        "ace_side_count": False,
        "tags": _tags(
            {"2": 1, "3": 1, "4": 2, "5": 2, "6": 2, "7": 1, "10": -2, "A": -1}
        ),
    },
    "halves": {
        "name": "Wong Halves",
        "level": 3,
        "balanced": True,
        "irc": 0,
        "ace_side_count": False,
        "tags": _tags(
            {
                "2": 0.5,
                "3": 1,
                "4": 1,
                "5": 1.5,
                "6": 1,
                "7": 0.5,
                "9": -0.5,
                "10": -1,
                "A": -1,
            }
        ),
    },
}

DEFAULT_SYSTEM = "hi_lo"


def initial_running_count(system_key: str, decks: int) -> float:
    s = SYSTEMS[system_key]
    if s["balanced"]:
        return 0
    if system_key == "ko":
        return 4 - 4 * decks
    return 0


def systems_payload(decks: int) -> list[dict]:
    """Systems in the shape the client consumes, with IRC resolved."""
    out = []
    for key, s in SYSTEMS.items():
        out.append(
            {
                "key": key,
                "name": s["name"],
                "level": s["level"],
                "balanced": s["balanced"],
                "ace_side_count": s["ace_side_count"],
                "tags": s["tags"],
                "irc": initial_running_count(key, decks),
            }
        )
    return out
