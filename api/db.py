"""SQLite access. One connection per request, rows as dicts."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("PITBOSS_DB", "/data/pitboss.db"))
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

DEFAULT_PROFILE = "default"

# Shipped presets. Each is an ordinary row, so a casino you play becomes a
# saved preset rather than anything hardcoded in the app.
PRESETS = [
    {
        "name": "6D S17 DAS LS (Vegas Strip)",
        "decks": 6, "h17": 0, "das": 1, "surrender": 1, "peek": 1,
        "resplit_limit": 4, "resplit_aces": 0, "double_any_two": 1,
        "blackjack_pays": 1.5, "penetration": 0.75, "other_players": 2,
        "is_default": 1,
    },
    {
        "name": "6D H17 DAS LS",
        "decks": 6, "h17": 1, "das": 1, "surrender": 1, "peek": 1,
        "resplit_limit": 4, "resplit_aces": 0, "double_any_two": 1,
        "blackjack_pays": 1.5, "penetration": 0.75, "other_players": 2,
        "is_default": 0,
    },
    {
        "name": "8D S17 DAS no surrender",
        "decks": 8, "h17": 0, "das": 1, "surrender": 0, "peek": 1,
        "resplit_limit": 4, "resplit_aces": 0, "double_any_two": 1,
        "blackjack_pays": 1.5, "penetration": 0.75, "other_players": 3,
        "is_default": 0,
    },
    {
        "name": "6D H17 no DAS no surrender",
        "decks": 6, "h17": 1, "das": 0, "surrender": 0, "peek": 1,
        "resplit_limit": 4, "resplit_aces": 0, "double_any_two": 1,
        "blackjack_pays": 1.5, "penetration": 0.70, "other_players": 2,
        "is_default": 0,
    },
]


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init() -> None:
    """Create the schema and seed the default profile and presets."""
    with session() as conn:
        conn.executescript(SCHEMA_PATH.read_text())
        conn.execute(
            "INSERT OR IGNORE INTO profiles (name) VALUES (?)", (DEFAULT_PROFILE,)
        )
        pid = conn.execute(
            "SELECT id FROM profiles WHERE name = ?", (DEFAULT_PROFILE,)
        ).fetchone()["id"]
        existing = conn.execute(
            "SELECT COUNT(*) AS n FROM rule_sets WHERE profile_id = ?", (pid,)
        ).fetchone()["n"]
        if existing == 0:
            for p in PRESETS:
                cols = ["profile_id"] + list(p.keys())
                vals = [pid] + list(p.values())
                conn.execute(
                    f"INSERT INTO rule_sets ({','.join(cols)}) "
                    f"VALUES ({','.join('?' * len(cols))})",
                    vals,
                )


def profile_id(conn: sqlite3.Connection, name: str = DEFAULT_PROFILE) -> int:
    row = conn.execute("SELECT id FROM profiles WHERE name = ?", (name,)).fetchone()
    if row is None:
        cur = conn.execute("INSERT INTO profiles (name) VALUES (?)", (name,))
        return int(cur.lastrowid)
    return int(row["id"])


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def rule_set_to_rules(row: dict) -> dict:
    """Translate a rule_sets row into the dict the strategy resolver takes."""
    return {
        "decks": row["decks"],
        "h17": bool(row["h17"]),
        "das": bool(row["das"]),
        "surrender": bool(row["surrender"]),
        "peek": bool(row["peek"]),
        "resplit_limit": row["resplit_limit"],
        "resplit_aces": bool(row["resplit_aces"]),
        "double_any_two": bool(row["double_any_two"]),
        "blackjack_pays": row["blackjack_pays"],
        "penetration": row["penetration"],
        "other_players": row["other_players"],
    }
