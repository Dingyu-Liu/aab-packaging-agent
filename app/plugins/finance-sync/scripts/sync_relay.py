#!/usr/bin/env python3
"""跨机器审计日志中转：推送本机运行记录到飞书中转表 / 拉取别人机器推上来的记录。

场景：广告同步在本机跑，消耗同步在同事机器上跑；两台机器各留一份本地库，
通过飞书多维表格「同步运行日志」表做中转，主机器手动拉取后即可在本地库统一查询/回滚。

用法：
  python3 sync_relay.py push [--run <run_id>] [--all] [--dry]   推送（默认推最近一次运行）
  python3 sync_relay.py pull [--dry]                            拉取（把中转表的新记录并入本地库）
  python3 sync_relay.py status                                  查看中转表现状与本地缺口
"""
import os
import sys

import sync_log


def _local_runs():
    with sync_log._conn() as c:
        return [r["run_id"] for r in
                c.execute("SELECT run_id FROM runs ORDER BY started_at DESC").fetchall()]


def cmd_push():
    dry = "--dry" in sys.argv
    if "--all" in sys.argv:
        runs = _local_runs()
        print(f"[中转] 逐条检查本地 {len(runs)} 次运行")
        total = 0
        for rid in runs:
            total += sync_log.push_run(rid, dry=dry)
        print(f"[中转] 合计推送 {total} 条")
        return
    rid = None
    if "--run" in sys.argv:
        rid = sys.argv[sys.argv.index("--run") + 1]
    rid = rid or sync_log.current_run_id()
    if not rid:
        rid = (_local_runs() or [None])[0]
    if not rid:
        print("[中转] 本地库还没有任何运行记录")
        return
    sync_log.push_run(rid, dry=dry)


def cmd_pull():
    sync_log.pull_relay(dry=("--dry" in sys.argv))


def cmd_status():
    base, table = sync_log.RELAY_BASE, sync_log.RELAY_TABLE
    rows = sync_log._relay_list(base, table, ["记录键", "记录类型", "机器", "运行ID", "时间", "结果", "产品"])
    print(f"[中转] 中转表 {base}/{table} 共 {len(rows)} 条")
    by_m = {}
    by_k = {}
    for r in rows:
        by_m[str(r.get("机器") or "?")] = by_m.get(str(r.get("机器") or "?"), 0) + 1
        by_k[str(r.get("记录类型") or "?")] = by_k.get(str(r.get("记录类型") or "?"), 0) + 1
    print(f"  按机器: {by_m}")
    print(f"  按类型: {by_k}")
    with sync_log._conn() as c:
        local = {x[0] for x in c.execute("SELECT ext_key FROM runs WHERE ext_key IS NOT NULL")}
        for t in ("steps", "rule_runs", "cell_changes", "dapan_changes", "card_pushes"):
            local |= {x[0] for x in c.execute(f"SELECT ext_key FROM {t} WHERE ext_key IS NOT NULL")}
    miss = [r for r in rows if str(r.get("记录键")) not in local]
    print(f"[中转] 本地尚未并入的新记录: {len(miss)} 条"
          + (f"（来自 {sorted({str(m.get('机器')) for m in miss})}）" if miss else ""))
    seen = {}
    for r in rows:
        rid = str(r.get("运行ID"))
        seen[rid] = seen.get(rid, 0) + 1
    newest = sorted(seen)[-5:]
    print("[中转] 最近的运行ID:", newest)


CMDS = {"push": cmd_push, "pull": cmd_pull, "status": cmd_status}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in CMDS:
        print(__doc__)
        sys.exit(1)
    sync_log.init()
    CMDS[cmd]()
