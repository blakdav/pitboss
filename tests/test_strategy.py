"""Verify the resolved chart against the published strategy, cell by cell.

Reference: Wizard of Odds, "4-Deck to 8-Deck Blackjack Strategy", text form
for dealer stands on soft 17 with surrender allowed, plus the listed
modifications for dealer hits soft 17.
https://wizardofodds.com/games/blackjack/strategy/4-decks/

These tests re-derive every cell from the published prose rather than
restating the table in the module, so a typo in the chart fails here instead
of quietly teaching the wrong play.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from api import strategy  # noqa: E402

UP = strategy.UPCARDS
S17 = {"h17": False, "das": True, "surrender": True}
H17 = {"h17": True, "das": True, "surrender": True}


def cell(chart, group, key, up):
    return strategy.lookup(chart, group, key, up)


def up_in(up, lo, hi):
    """Upcard between two numeric bounds; the ace is outside every range."""
    if up == "A":
        return False
    return lo <= int(up) <= hi


# --- hard totals -----------------------------------------------------------


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("total", range(4, 22))
def test_hard_totals_s17(total, up):
    chart = strategy.resolve(S17)
    got = cell(chart, "hard", total, up)

    if total <= 8:
        expected = "H"                                    # always hit hard 11 or less
    elif total == 9:
        expected = "D" if up_in(up, 3, 6) else "H"        # double hard 9 vs 3-6
    elif total == 10:
        expected = "H" if up in ("10", "A") else "D"      # double except vs 10, A
    elif total == 11:
        expected = "H" if up == "A" else "D"              # double except vs A
    elif total == 12:
        expected = "S" if up_in(up, 4, 6) else "H"        # stand vs 4-6
    elif total <= 16:
        expected = "S" if up_in(up, 2, 6) else "H"        # stand 13-16 vs 2-6
    else:
        expected = "S"                                    # always stand on 17+

    assert got == expected, f"hard {total} vs {up}: {got} != {expected}"


# --- soft totals -----------------------------------------------------------


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("total", range(13, 22))
def test_soft_totals_s17(total, up):
    chart = strategy.resolve(S17)
    got = cell(chart, "soft", total, up)

    if total in (13, 14):
        expected = "D" if up_in(up, 5, 6) else "H"        # double soft 13/14 vs 5-6
    elif total in (15, 16):
        expected = "D" if up_in(up, 4, 6) else "H"        # double soft 15/16 vs 4-6
    elif total == 17:
        expected = "D" if up_in(up, 3, 6) else "H"        # double soft 17 vs 3-6
    elif total == 18:
        if up_in(up, 3, 6):
            expected = "DS"                               # double soft 18 vs 3-6
        elif up in ("9", "10", "A"):
            expected = "H"                                # hit vs 9, 10, A
        else:
            expected = "S"
    else:
        expected = "S"                                    # always stand soft 19+

    assert got == expected, f"soft {total} vs {up}: {got} != {expected}"


# --- pairs -----------------------------------------------------------------


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("rank", ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
def test_pairs_das(rank, up):
    chart = strategy.resolve(S17)
    got = cell(chart, "pair", rank, up)

    if rank in ("A", "8"):
        expected = "P"                                    # always split aces and 8s
    elif rank in ("2", "3"):
        expected = "P" if up_in(up, 2, 7) else "H"        # vs 4-7, plus 2-3 with DAS
    elif rank == "4":
        expected = "P" if up_in(up, 5, 6) else "H"        # only with DAS, vs 5-6
    elif rank == "5":
        expected = "H" if up in ("10", "A") else "D"      # never split: hard 10
    elif rank == "6":
        expected = "P" if up_in(up, 2, 6) else "H"        # vs 3-6, plus 2 with DAS
    elif rank == "7":
        expected = "P" if up_in(up, 2, 7) else "H"        # vs 2-7
    elif rank == "9":
        expected = "P" if (up_in(up, 2, 6) or up_in(up, 8, 9)) else "S"
    else:
        expected = "S"                                    # never split 10s: hard 20

    assert got == expected, f"pair {rank} vs {up}: {got} != {expected}"


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("rank", ["2", "3", "4", "6"])
def test_pairs_no_das(rank, up):
    """Without DAS the DAS-only splits fall back to hitting; the rest hold."""
    chart = strategy.resolve({**S17, "das": False})
    got = cell(chart, "pair", rank, up)

    if rank in ("2", "3"):
        expected = "P" if up_in(up, 4, 7) else "H"
    elif rank == "4":
        expected = "H"
    else:  # 6s
        expected = "P" if up_in(up, 3, 6) else "H"

    assert got == expected, f"no-DAS pair {rank} vs {up}: {got} != {expected}"


# --- surrender -------------------------------------------------------------


def test_surrender_s17():
    chart = strategy.resolve(S17)
    s = chart["surrender"]
    assert s["hard:15"] == ["10"]
    assert s["hard:16"] == ["9", "10", "A"]
    # A pair of 8s is never surrendered under S17; it is addressed on its own
    # key so the hard-16 entry cannot pick it up.
    assert "pair:8" not in s


def test_surrender_absent_when_rule_off():
    chart = strategy.resolve({**S17, "surrender": False})
    assert chart["surrender"] == {}


# --- H17 delta set ---------------------------------------------------------


def test_h17_deltas_are_exactly_the_published_four():
    """H17 changes four things and nothing else."""
    s17 = strategy.resolve(S17)
    h17 = strategy.resolve(H17)

    diffs = set()
    for group in ("hard", "soft", "pair"):
        for key, row in s17[group].items():
            for i, code in enumerate(row):
                if h17[group][key][i] != code:
                    diffs.add((group, key, UP[i], code, h17[group][key][i]))

    assert diffs == {
        ("hard", "11", "A", "H", "D"),     # double 11 vs A
        ("soft", "18", "2", "S", "DS"),    # double soft 18 vs 2
        ("soft", "19", "6", "S", "DS"),    # double soft 19 vs 6
    }

    # The fourth published change is a surrender addition, not a chart cell.
    assert h17["surrender"]["hard:15"] == ["10", "A"]
    assert h17["surrender"]["hard:17"] == ["A"]
    assert h17["surrender"]["pair:8"] == ["A"]
    assert h17["surrender"]["hard:16"] == ["9", "10", "A"]


def test_h17_does_not_leak_into_s17():
    """Resolving H17 must not mutate the module-level base tables."""
    strategy.resolve(H17)
    again = strategy.resolve(S17)
    assert strategy.lookup(again, "hard", 11, "A") == "H"
    assert "pair:8" not in again["surrender"]


# --- resolver contract -----------------------------------------------------


def test_no_conditional_codes_survive_resolution():
    """The client must never see a rule-conditional code."""
    for rules in (S17, H17, {**S17, "das": False}, {**H17, "das": False}):
        chart = strategy.resolve(rules)
        for group in ("hard", "soft", "pair"):
            for key, row in chart[group].items():
                assert "PH" not in row, f"unresolved PH at {group} {key}"


def test_double_restriction_removes_soft_doubles():
    chart = strategy.resolve({**S17, "double_any_two": False})
    for total, row in chart["soft"].items():
        assert "D" not in row, f"soft {total} still doubles"
        assert "DS" not in row, f"soft {total} still doubles"
    # Hard doubles on 9/10/11 are unaffected.
    assert strategy.lookup(chart, "hard", 11, "9") == "D"


def test_supported_decks_are_the_verified_ones():
    assert strategy.SUPPORTED_DECKS == [4, 6, 8]
