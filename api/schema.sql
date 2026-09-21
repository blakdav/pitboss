-- pitboss schema. All settings and history live here; the browser keeps
-- nothing but a short-lived outbound buffer.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rule_sets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    decks           INTEGER NOT NULL DEFAULT 6,
    h17             INTEGER NOT NULL DEFAULT 0,
    das             INTEGER NOT NULL DEFAULT 1,
    surrender       INTEGER NOT NULL DEFAULT 1,
    peek            INTEGER NOT NULL DEFAULT 1,
    resplit_limit   INTEGER NOT NULL DEFAULT 4,
    resplit_aces    INTEGER NOT NULL DEFAULT 0,
    double_any_two  INTEGER NOT NULL DEFAULT 1,
    blackjack_pays  REAL    NOT NULL DEFAULT 1.5,
    penetration     REAL    NOT NULL DEFAULT 0.75,
    other_players   INTEGER NOT NULL DEFAULT 2,
    is_default      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (profile_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    rule_set_id     INTEGER NOT NULL REFERENCES rule_sets(id),
    mode            TEXT NOT NULL,              -- 'tutor' | 'simulation'
    counting_system TEXT NOT NULL DEFAULT 'hi_lo',
    layers          TEXT NOT NULL DEFAULT '["basic"]',  -- JSON array
    seed            INTEGER NOT NULL,
    state_json      TEXT,                       -- resume payload
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    active          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(profile_id, active, updated_at DESC);

-- One row per action taken. Every stats view is a query over this table,
-- so a new metric later is a query, not a migration.
CREATE TABLE IF NOT EXISTS decisions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_uid       TEXT NOT NULL,             -- idempotency key from the buffer
    hand_index       INTEGER NOT NULL,
    cards_dealt      INTEGER NOT NULL,          -- shoe position at decision
    player_cards     TEXT NOT NULL,             -- JSON array of ranks
    player_total     INTEGER NOT NULL,
    is_soft          INTEGER NOT NULL,
    is_pair          INTEGER NOT NULL,
    from_split       INTEGER NOT NULL DEFAULT 0,
    dealer_upcard    TEXT NOT NULL,
    running_count    REAL NOT NULL,
    true_count       REAL NOT NULL,
    action           TEXT NOT NULL,
    correct_action   TEXT NOT NULL,
    error_class      TEXT NOT NULL,             -- correct | strategy_error | missed_deviation | count_error
    latency_ms       INTEGER,
    input_type       TEXT NOT NULL DEFAULT 'unknown',  -- touch | mouse | key
    mode             TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, client_uid)
);

CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_cell
    ON decisions(player_total, is_soft, is_pair, dealer_upcard);

-- Count-accuracy prompts, kept apart from play decisions so a drifted count
-- never reads as a strategy problem.
CREATE TABLE IF NOT EXISTS count_checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_uid    TEXT NOT NULL,
    cards_dealt   INTEGER NOT NULL,
    decks_left    REAL NOT NULL,
    reported_rc   REAL NOT NULL,
    actual_rc     REAL NOT NULL,
    reported_tc   REAL,
    actual_tc     REAL NOT NULL,
    latency_ms    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, client_uid)
);

CREATE INDEX IF NOT EXISTS idx_count_checks_session ON count_checks(session_id);
