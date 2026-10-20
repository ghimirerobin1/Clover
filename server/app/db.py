"""Small SQLite store for device keys, pairing codes, idempotency and audit.

Uses the stdlib sqlite3 driver; each call opens a short-lived connection, which is plenty for
a two-location shop and keeps the code free of pooling concerns.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    can_create_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    can_create_items INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
    client_mutation_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
    status_code INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (device_id, client_mutation_id)
);

-- Populated by stock writes in Milestone 4; created now so the schema is stable.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_qty REAL,
    after_qty REAL,
    reason TEXT,
    client_mutation_id TEXT,
    clover_status INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS audit_log_item ON audit_log (location_id, item_id);
"""


class Database:
    def __init__(self, path: str) -> None:
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
        finally:
            conn.close()

    def migrate(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
