"""pitboss API + static frontend, served by one uvicorn process."""

import json
import random
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import counting, db, strategy

WEB_DIR = Path(__file__).parent.parent / "web"

@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


app = FastAPI(
    title="pitboss",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


# --- models ---------------------------------------------------------------


class RuleSetIn(BaseModel):
    name: str
    decks: int = 6
    h17: bool = False
    das: bool = True
    surrender: bool = True
    peek: bool = True
    resplit_limit: int = 4
    resplit_aces: bool = False
    double_any_two: bool = True
    blackjack_pays: float = 1.5
    penetration: float = 0.75
    other_players: int = 2


class SessionIn(BaseModel):
    rule_set_id: int
    mode: Literal["tutor", "simulation"] = "tutor"
    counting_system: str = counting.DEFAULT_SYSTEM
    layers: list[str] = Field(default_factory=lambda: ["basic"])
    seed: int | None = None


class StateIn(BaseModel):
    state: dict[str, Any]


class DecisionIn(BaseModel):
    client_uid: str
    hand_index: int
    cards_dealt: int
    player_cards: list[str]
    player_total: int
    is_soft: bool
    is_pair: bool
    from_split: bool = False
    dealer_upcard: str
    running_count: float
    true_count: float
    action: str
    correct_action: str
    error_class: str
    latency_ms: int | None = None
    input_type: str = "unknown"
    mode: str


class DecisionBatch(BaseModel):
    decisions: list[DecisionIn]


class CountCheckIn(BaseModel):
    client_uid: str
    cards_dealt: int
    decks_left: float
    reported_rc: float
    actual_rc: float
    reported_tc: float | None = None
    actual_tc: float
    latency_ms: int | None = None


class CountCheckBatch(BaseModel):
    checks: list[CountCheckIn]


# --- helpers --------------------------------------------------------------


def _rule_set(conn, rule_set_id: int, pid: int) -> dict:
    row = conn.execute(
        "SELECT * FROM rule_sets WHERE id = ? AND profile_id = ?",
        (rule_set_id, pid),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "rule set not found")
    return dict(row)


def _session_payload(conn, row: dict) -> dict:
    rs = dict(
        conn.execute(
            "SELECT * FROM rule_sets WHERE id = ?", (row["rule_set_id"],)
        ).fetchone()
    )
    rules = db.rule_set_to_rules(rs)
    return {
        "session": {
            "id": row["id"],
            "mode": row["mode"],
            "counting_system": row["counting_system"],
            "layers": json.loads(row["layers"]),
            "seed": row["seed"],
            "state": json.loads(row["state_json"]) if row["state_json"] else None,
            "started_at": row["started_at"],
        },
        "rule_set": rs,
        "chart": strategy.resolve(rules),
        "counting": {
            "systems": counting.systems_payload(rs["decks"]),
            "selected": row["counting_system"],
        },
    }


# --- routes ---------------------------------------------------------------


@app.get("/api/bootstrap")
def bootstrap() -> dict:
    """Everything the client needs on load, including any session to resume."""
    with db.session() as conn:
        pid = db.profile_id(conn)
        rule_sets = db.rows(
            conn.execute(
                "SELECT * FROM rule_sets WHERE profile_id = ? ORDER BY is_default DESC, name",
                (pid,),
            )
        )
        active = conn.execute(
            "SELECT * FROM sessions WHERE profile_id = ? AND active = 1 "
            "ORDER BY updated_at DESC LIMIT 1",
            (pid,),
        ).fetchone()
        resume = _session_payload(conn, dict(active)) if active else None
        return {
            "profile": db.DEFAULT_PROFILE,
            "rule_sets": rule_sets,
            "supported_decks": strategy.SUPPORTED_DECKS,
            "counting_systems": counting.systems_payload(6),
            "resume": resume,
        }


@app.post("/api/rule_sets")
def create_rule_set(body: RuleSetIn) -> dict:
    if body.decks not in strategy.SUPPORTED_DECKS:
        raise HTTPException(
            400,
            f"deck count {body.decks} is not supported; the shipped chart is "
            f"verified for {strategy.SUPPORTED_DECKS} decks only",
        )
    with db.session() as conn:
        pid = db.profile_id(conn)
        data = body.model_dump()
        cols = ["profile_id"] + list(data.keys())
        vals = [pid] + [int(v) if isinstance(v, bool) else v for v in data.values()]
        try:
            cur = conn.execute(
                f"INSERT INTO rule_sets ({','.join(cols)}) "
                f"VALUES ({','.join('?' * len(cols))})",
                vals,
            )
        except Exception:
            raise HTTPException(409, "a rule set with that name already exists")
        row = conn.execute(
            "SELECT * FROM rule_sets WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)


@app.put("/api/rule_sets/{rule_set_id}")
def update_rule_set(rule_set_id: int, body: RuleSetIn) -> dict:
    if body.decks not in strategy.SUPPORTED_DECKS:
        raise HTTPException(400, f"deck count {body.decks} is not supported")
    with db.session() as conn:
        pid = db.profile_id(conn)
        _rule_set(conn, rule_set_id, pid)
        data = body.model_dump()
        sets = ", ".join(f"{k} = ?" for k in data)
        vals = [int(v) if isinstance(v, bool) else v for v in data.values()]
        conn.execute(
            f"UPDATE rule_sets SET {sets} WHERE id = ? AND profile_id = ?",
            vals + [rule_set_id, pid],
        )
        return dict(
            conn.execute("SELECT * FROM rule_sets WHERE id = ?", (rule_set_id,)).fetchone()
        )


@app.delete("/api/rule_sets/{rule_set_id}")
def delete_rule_set(rule_set_id: int) -> dict:
    with db.session() as conn:
        pid = db.profile_id(conn)
        _rule_set(conn, rule_set_id, pid)
        in_use = conn.execute(
            "SELECT COUNT(*) AS n FROM sessions WHERE rule_set_id = ?", (rule_set_id,)
        ).fetchone()["n"]
        if in_use:
            raise HTTPException(409, "rule set has sessions recorded against it")
        conn.execute("DELETE FROM rule_sets WHERE id = ?", (rule_set_id,))
        return {"deleted": rule_set_id}


@app.get("/api/strategy/{rule_set_id}")
def get_strategy(rule_set_id: int) -> dict:
    with db.session() as conn:
        pid = db.profile_id(conn)
        rs = _rule_set(conn, rule_set_id, pid)
        return strategy.resolve(db.rule_set_to_rules(rs))


@app.post("/api/sessions")
def create_session(body: SessionIn) -> dict:
    with db.session() as conn:
        pid = db.profile_id(conn)
        _rule_set(conn, body.rule_set_id, pid)
        # One active session at a time; starting a new one closes the old.
        conn.execute(
            "UPDATE sessions SET active = 0, ended_at = datetime('now') "
            "WHERE profile_id = ? AND active = 1",
            (pid,),
        )
        seed = body.seed if body.seed is not None else random.getrandbits(31)
        cur = conn.execute(
            "INSERT INTO sessions (profile_id, rule_set_id, mode, counting_system, "
            "layers, seed) VALUES (?, ?, ?, ?, ?, ?)",
            (
                pid,
                body.rule_set_id,
                body.mode,
                body.counting_system,
                json.dumps(body.layers),
                seed,
            ),
        )
        row = dict(
            conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        )
        return _session_payload(conn, row)


@app.get("/api/sessions/{session_id}")
def get_session(session_id: int) -> dict:
    with db.session() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "session not found")
        return _session_payload(conn, dict(row))


@app.put("/api/sessions/{session_id}/state")
def save_state(session_id: int, body: StateIn) -> dict:
    """Resume point. Written after each hand so a bus stop costs one hand."""
    with db.session() as conn:
        cur = conn.execute(
            "UPDATE sessions SET state_json = ?, updated_at = datetime('now') "
            "WHERE id = ? AND active = 1",
            (json.dumps(body.state), session_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "no active session with that id")
        return {"saved": True}


@app.post("/api/sessions/{session_id}/end")
def end_session(session_id: int) -> dict:
    with db.session() as conn:
        conn.execute(
            "UPDATE sessions SET active = 0, ended_at = datetime('now') WHERE id = ?",
            (session_id,),
        )
        return {"ended": session_id}


@app.post("/api/sessions/{session_id}/decisions")
def post_decisions(session_id: int, body: DecisionBatch) -> dict:
    """Accepts a batch from the client's outbound buffer. Idempotent on
    client_uid so a replayed flush after a dead zone cannot double-count."""
    with db.session() as conn:
        exists = conn.execute(
            "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if exists is None:
            raise HTTPException(404, "session not found")
        n = 0
        for d in body.decisions:
            cur = conn.execute(
                "INSERT OR IGNORE INTO decisions (session_id, client_uid, hand_index, "
                "cards_dealt, player_cards, player_total, is_soft, is_pair, from_split, "
                "dealer_upcard, running_count, true_count, action, correct_action, "
                "error_class, latency_ms, input_type, mode) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    session_id, d.client_uid, d.hand_index, d.cards_dealt,
                    json.dumps(d.player_cards), d.player_total, int(d.is_soft),
                    int(d.is_pair), int(d.from_split), d.dealer_upcard,
                    d.running_count, d.true_count, d.action, d.correct_action,
                    d.error_class, d.latency_ms, d.input_type, d.mode,
                ),
            )
            n += cur.rowcount
        return {"accepted": len(body.decisions), "inserted": n}


@app.post("/api/sessions/{session_id}/count_checks")
def post_count_checks(session_id: int, body: CountCheckBatch) -> dict:
    with db.session() as conn:
        n = 0
        for c in body.checks:
            cur = conn.execute(
                "INSERT OR IGNORE INTO count_checks (session_id, client_uid, cards_dealt, "
                "decks_left, reported_rc, actual_rc, reported_tc, actual_tc, latency_ms) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    session_id, c.client_uid, c.cards_dealt, c.decks_left,
                    c.reported_rc, c.actual_rc, c.reported_tc, c.actual_tc,
                    c.latency_ms,
                ),
            )
            n += cur.rowcount
        return {"accepted": len(body.checks), "inserted": n}


@app.get("/api/stats/summary")
def stats_summary(days: int | None = None) -> dict:
    where = "WHERE 1=1"
    params: list[Any] = []
    if days:
        where += " AND d.created_at >= datetime('now', ?)"
        params.append(f"-{int(days)} days")

    with db.session() as conn:
        overall = dict(
            conn.execute(
                f"SELECT COUNT(*) AS decisions, "
                f"SUM(CASE WHEN error_class = 'correct' THEN 1 ELSE 0 END) AS correct, "
                f"AVG(latency_ms) AS avg_latency "
                f"FROM decisions d {where}",
                params,
            ).fetchone()
        )
        by_day = db.rows(
            conn.execute(
                f"SELECT date(d.created_at) AS day, COUNT(*) AS n, "
                f"SUM(CASE WHEN error_class = 'correct' THEN 1 ELSE 0 END) AS correct, "
                f"AVG(latency_ms) AS avg_latency "
                f"FROM decisions d {where} GROUP BY day ORDER BY day",
                params,
            )
        )
        by_class = db.rows(
            conn.execute(
                f"SELECT error_class, COUNT(*) AS n FROM decisions d {where} "
                f"GROUP BY error_class",
                params,
            )
        )
        # Per-cell accuracy: the heatmap of which chart cells actually get missed.
        cells = db.rows(
            conn.execute(
                f"SELECT player_total, is_soft, is_pair, dealer_upcard, "
                f"COUNT(*) AS n, "
                f"SUM(CASE WHEN error_class = 'correct' THEN 1 ELSE 0 END) AS correct "
                f"FROM decisions d {where} "
                f"GROUP BY player_total, is_soft, is_pair, dealer_upcard "
                f"HAVING n > 0 ORDER BY (1.0 * correct / n) ASC, n DESC",
                params,
            )
        )
        worst = db.rows(
            conn.execute(
                f"SELECT player_total, is_soft, is_pair, dealer_upcard, action, "
                f"correct_action, COUNT(*) AS n FROM decisions d {where} "
                f"AND error_class != 'correct' "
                f"GROUP BY player_total, is_soft, is_pair, dealer_upcard, action, "
                f"correct_action ORDER BY n DESC LIMIT 12",
                params,
            )
        )
        by_input = db.rows(
            conn.execute(
                f"SELECT input_type, COUNT(*) AS n, AVG(latency_ms) AS avg_latency, "
                f"SUM(CASE WHEN error_class = 'correct' THEN 1 ELSE 0 END) AS correct "
                f"FROM decisions d {where} GROUP BY input_type",
                params,
            )
        )
        count_acc = dict(
            conn.execute(
                "SELECT COUNT(*) AS n, AVG(ABS(reported_rc - actual_rc)) AS mean_abs_err "
                "FROM count_checks"
            ).fetchone()
        )
        sessions = db.rows(
            conn.execute(
                "SELECT s.id, s.mode, s.started_at, s.ended_at, s.active, r.name AS rule_set, "
                "(SELECT COUNT(*) FROM decisions d2 WHERE d2.session_id = s.id) AS decisions "
                "FROM sessions s JOIN rule_sets r ON r.id = s.rule_set_id "
                "ORDER BY s.started_at DESC LIMIT 20"
            )
        )
        return {
            "overall": overall,
            "by_day": by_day,
            "by_class": by_class,
            "cells": cells,
            "worst": worst,
            "by_input": by_input,
            "count_accuracy": count_acc,
            "sessions": sessions,
        }


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
