"""Server-side idempotency for writes, keyed by (device_id, clientMutationId).

Protocol:
* begin() inserts a 'pending' row. If the row already exists:
    - different request body           -> CONFLICT (id reuse)
    - still 'pending'                  -> CONFLICT (in flight, or outcome unknown: re-read before retrying)
    - 'done'                           -> Replay of the stored result; Clover is NOT called again
* complete() stores Clover's status + body.
* release() deletes the pending row when Clover definitely did not apply the write (e.g. 429),
  so the same id may be retried later.
* On a transport failure mid-write the row stays 'pending' forever: the app must re-read and
  start a new mutation with a fresh id (spec §4.4 step 6).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .db import Database
from .errors import ErrorMapper
from .timeutil import Clock


@dataclass(frozen=True)
class Replay:
    status_code: int
    body: Any


class IdempotencyStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def request_hash(method: str, path: str, body: Any) -> str:
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(f"{method.upper()} {path}\n{canonical}".encode()).hexdigest()

    def begin(self, device_id: str, client_mutation_id: str, request_hash: str) -> Replay | None:
        if not client_mutation_id or len(client_mutation_id) > 128:
            raise ErrorMapper.validation("clientMutationId must be 1-128 characters")
        with self.db.connect() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO idempotency "
                "(client_mutation_id, device_id, request_hash, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
                (client_mutation_id, device_id, request_hash, Clock.iso()),
            )
            if cur.rowcount == 1:
                return None
            row = conn.execute(
                "SELECT request_hash, state, status_code, response_json FROM idempotency "
                "WHERE device_id = ? AND client_mutation_id = ?",
                (device_id, client_mutation_id),
            ).fetchone()
        if row["request_hash"] != request_hash:
            raise ErrorMapper.conflict("clientMutationId was already used for a different request")
        if row["state"] == "pending":
            raise ErrorMapper.conflict(
                "A previous attempt with this clientMutationId is in progress or its outcome is unknown; "
                "re-read the item and start a new change"
            )
        return Replay(status_code=int(row["status_code"]), body=json.loads(row["response_json"]))

    def complete(self, device_id: str, client_mutation_id: str, status_code: int, body: Any) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE idempotency SET state = 'done', status_code = ?, response_json = ?, completed_at = ? "
                "WHERE device_id = ? AND client_mutation_id = ?",
                (status_code, json.dumps(body), Clock.iso(), device_id, client_mutation_id),
            )

    def release(self, device_id: str, client_mutation_id: str) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "DELETE FROM idempotency WHERE device_id = ? AND client_mutation_id = ? AND state = 'pending'",
                (device_id, client_mutation_id),
            )
