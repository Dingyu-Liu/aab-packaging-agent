#!/usr/bin/env python3
"""Read the four live rule tables into this run's private snapshot.

Only the explicit consume sync / dapan preparation stage calls main().
No synchronization, cards, audit relay or selfcheck is invoked here.
"""
import json
import os
from pathlib import Path

from codex_lark_adapter import list_records
from full_review import TABLES


def main():
    snapshot = {}
    for source in ("topon", "max", "admob", "consume"):
        base, table = TABLES[source]
        records = list_records(base, table)
        if not isinstance(records, list) or any(not isinstance(row, dict) or not isinstance(row.get("fields"), dict) for row in records):
            raise ValueError("Invalid rules for " + source)
        snapshot[source] = records
        print("Rules %s: %s" % (source, len(records)))
    if not snapshot["consume"] or not any(snapshot[source] for source in ("topon", "max", "admob")):
        raise ValueError("Complete rules snapshot requires consume and advertising mappings")
    path = Path(__file__).resolve().parent / "rules_full.json"
    pending = path.with_suffix(".json.tmp")
    with pending.open("w", encoding="utf-8") as output:
        json.dump(snapshot, output, ensure_ascii=False, indent=1)
    os.replace(pending, path)
    print("Prepared a complete local rules snapshot; remote reads only")


if __name__ == "__main__":
    main()
