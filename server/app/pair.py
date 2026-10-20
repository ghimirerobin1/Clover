"""Admin CLI for device pairing.

python -m app.pair                       # issue a pairing code (enter it in the app's Settings)
python -m app.pair --allow-create-items  # code whose device may create Clover items
python -m app.pair --list                # list paired devices
python -m app.pair --revoke DEVICE_ID    # revoke a device key
"""

from __future__ import annotations

import argparse
import sys

from .config import get_settings
from .db import Database
from .pairing import PairingService


class PairCli:
    @staticmethod
    def run(argv: list[str] | None = None) -> int:
        parser = argparse.ArgumentParser(prog="python -m app.pair", description=__doc__.splitlines()[0])
        parser.add_argument("--allow-create-items", action="store_true", help="grant canCreateItems")
        parser.add_argument("--list", action="store_true", help="list paired devices")
        parser.add_argument("--revoke", metavar="DEVICE_ID", help="revoke a device")
        args = parser.parse_args(argv)

        settings = get_settings()
        db = Database(settings.database_path)
        db.migrate()
        service = PairingService(db, settings.pairing_code_ttl_sec)

        if args.list:
            for d in service.list_devices():
                status = "revoked" if d["revoked_at"] else "active"
                print(
                    f"{d['id']}  {d['name']:<24} {status:<8} create={bool(d['can_create_items'])} "
                    f"last_seen={d['last_seen_at'] or '-'}"
                )
            return 0
        if args.revoke:
            ok = service.revoke(args.revoke)
            print("Revoked." if ok else "No active device with that id.")
            return 0 if ok else 1

        issued = service.issue_code(can_create_items=args.allow_create_items)
        code = issued.code
        print(f"Pairing code: {code[:4]} {code[4:]}")
        print(f"Expires at:   {issued.expires_at.isoformat()} (single use)")
        return 0


if __name__ == "__main__":
    sys.exit(PairCli.run())
