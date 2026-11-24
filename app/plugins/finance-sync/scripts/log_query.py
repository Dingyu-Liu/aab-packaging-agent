#!/usr/bin/env python3
"""同步审计日志查询 / 回滚清单导出（读 sync_history.db）。

用法：
  python3 log_query.py stats                     # 日志库概览
  python3 log_query.py runs [--limit 20]         # 最近运行列表
  python3 log_query.py show <run_id>             # 某次运行详情（步骤/失败规则/大盘变更/卡片）
  python3 log_query.py changes <run_id> [--limit 200]   # 单元格级明细
  python3 log_query.py product "产品名" [--limit 50]      # 某产品的历史变更
  python3 log_query.py changed-on 2026-09-21 [--limit 200]    # 某天被改过哪些产品/表
  python3 log_query.py rollback <run_id> [--json]        # 导出该次的写回清单（人工执行）
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("SYNC_LOG_DB") or os.path.join(HERE, "sync_history.db")


def conn():
    c = sqlite3.connect(DB, timeout=20)
    c.row_factory = sqlite3.Row
    return c


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def cmd_stats():
    with conn() as c:
        q = lambda s: c.execute(s).fetchone()[0]
        print(f"  日志库: {DB}")
        print(f"  运行次数: {q('SELECT COUNT(*) FROM runs')}")
        print(f"  规则级记录: {q('SELECT COUNT(*) FROM rule_runs')}")
        print(f"  单元格变更: {q('SELECT COUNT(*) FROM cell_changes')}")
        print(f"  大盘字段变更: {q('SELECT COUNT(*) FROM dapan_changes')}")
        print(f"  卡片推送: {q('SELECT COUNT(*) FROM card_pushes')}")
        print(f"  最早/最近: {q('SELECT MIN(started_at) FROM runs')} ~ {q('SELECT MAX(started_at) FROM runs')}")


def cmd_runs():
    limit = int(arg("--limit", 20))
    with conn() as c:
        rows = c.execute(
            "SELECT r.run_id, r.started_at, r.finished_at, r.trigger, r.mode, r.data_day, r.ok, r.note,"
            " (SELECT COUNT(*) FROM rule_runs rr WHERE rr.run_id=r.run_id) rules,"
            " (SELECT COUNT(*) FROM rule_runs rr WHERE rr.run_id=r.run_id AND rr.ok=0) failed,"
            " (SELECT COUNT(*) FROM cell_changes cc WHERE cc.run_id=r.run_id) cells,"
            " (SELECT COUNT(*) FROM dapan_changes dc WHERE dc.run_id=r.run_id) dapan"
            " FROM runs r ORDER BY r.started_at DESC LIMIT ?", (limit,)).fetchall()
    for r in rows:
        print(f"  {r['run_id']}  {r['started_at']} → {r['finished_at'] or '进行中'}  [{r['trigger']}/{r['mode']}]"
              f"  数据日={r['data_day'] or '-'}")
        print(f"      规则 {r['rules']} 条（失败 {r['failed']}）  单元格变更 {r['cells']} 格  大盘变更 {r['dapan']} 处"
              f"  {'✅成功' if r['ok'] else ('❌有失败' if r['ok'] is not None else '')}  {r['note'] or ''}")


def cmd_show():
    rid = arg("run_id") or (sys.argv[2] if len(sys.argv) > 2 else None)
    if not rid:
        print("请给 run_id"); return
    with conn() as c:
        r = c.execute("SELECT * FROM runs WHERE run_id=?", (rid,)).fetchone()
        if not r:
            print(f"没有这个运行记录: {rid}"); return
        print(f"=== 运行 {r['run_id']}  {r['started_at']} → {r['finished_at'] or '进行中'}")
        print(f"    触发={r['trigger']} 模式={r['mode']} 数据日={r['data_day']} 结果={'成功' if r['ok'] else '有失败'} {r['note'] or ''}")
        print(f"    命令: {r['argv']}")
        print("\n  [步骤]")
        for s in c.execute("SELECT * FROM steps WHERE run_id=? ORDER BY id", (rid,)):
            print(f"    {s['step']:14s} {s['started_at'] or '-'} → {s['finished_at'] or '-'}"
                  f"  exit={s['exit_code']}  {'OK' if s['ok'] else 'FAIL'}  {s['summary'] or ''}")
        print("\n  [规则汇总]")
        tot = c.execute("SELECT COUNT(*) n, SUM(wrote) w, SUM(ok) o FROM rule_runs WHERE run_id=?", (rid,)).fetchone()
        print(f"    共 {tot['n']} 条，成功 {tot['o']}，写入 {tot['w'] or 0} 格")
        for s in c.execute("SELECT src_type, COUNT(*) n, SUM(wrote) w, SUM(ok) o FROM rule_runs WHERE run_id=? GROUP BY src_type", (rid,)):
            print(f"      {s['src_type']:8s} {s['o']}/{s['n']} 条，写 {s['w'] or 0} 格")
        fails = c.execute("SELECT src_type, product, platform, error FROM rule_runs WHERE run_id=? AND ok=0 ORDER BY src_type, product", (rid,)).fetchall()
        if fails:
            print(f"\n  [失败规则 {len(fails)} 条]")
            for f in fails:
                print(f"    [{f['src_type']}] {f['product']} {f['platform'] or ''} — {(f['error'] or '')[:110]}")
        print("\n  [单元格变更]")
        cc = c.execute("SELECT COUNT(*) n, COUNT(DISTINCT product) p, COUNT(DISTINCT doc_token) d FROM cell_changes WHERE run_id=?", (rid,)).fetchone()
        print(f"    共 {cc['n']} 格，涉及 {cc['p']} 个产品 / {cc['d']} 个文档")
        for s in c.execute("SELECT product, COUNT(*) n FROM cell_changes WHERE run_id=? GROUP BY product ORDER BY n DESC LIMIT 15", (rid,)):
            print(f"      {s['product']}: {s['n']} 格")
        dc = c.execute("SELECT COUNT(*) n FROM dapan_changes WHERE run_id=?", (rid,)).fetchone()["n"]
        print(f"\n  [大盘字段变更] {dc} 处")
        for s in c.execute("SELECT product, field, old_value, new_value FROM dapan_changes WHERE run_id=? ORDER BY id LIMIT 20", (rid,)):
            print(f"      {s['product']} {s['field']}: {s['old_value']} → {s['new_value']}")
        for s in c.execute("SELECT * FROM card_pushes WHERE run_id=?", (rid,)):
            print(f"\n  [卡片] {s['sent_at']} → {s['target']} {'成功' if s['ok'] else '失败'} {s['detail'] or ''}")


def cmd_changes():
    rid = arg("run_id") or (sys.argv[2] if len(sys.argv) > 2 else None)
    limit = int(arg("--limit", 200))
    with conn() as c:
        rows = c.execute("SELECT * FROM cell_changes WHERE run_id=? ORDER BY id LIMIT ?", (rid, limit)).fetchall()
    print(f"运行 {rid} 的单元格变更（前 {len(rows)} 条）：")
    for r in rows:
        print(f"  [{r['src_type']}] {r['product']} {r['platform'] or ''} | doc={r['doc_token']} sheet={r['sheet_id']}"
              f" | {r['cell']} ({r['metric']}) : {r['old_value']} → {r['new_value']}")


def cmd_product():
    name = arg("--name") or (sys.argv[2] if len(sys.argv) > 2 else None)
    limit = int(arg("--limit", 50))
    with conn() as c:
        rows = c.execute("SELECT * FROM cell_changes WHERE product LIKE ? ORDER BY id DESC LIMIT ?",
                         (f"%{name}%", limit)).fetchall()
    print(f"产品「{name}」最近的单元格变更（{len(rows)} 条）：")
    for r in rows:
        print(f"  {r['changed_at']} run={r['run_id']} [{r['src_type']}] {r['product']} {r['platform'] or ''}"
              f" | {r['cell']} ({r['metric']}): {r['old_value']} → {r['new_value']}")


def cmd_changed_on():
    day = sys.argv[2] if len(sys.argv) > 2 else None
    with conn() as c:
        rows = c.execute(
            "SELECT run_id, src_type, product, platform, COUNT(*) n FROM cell_changes"
            " WHERE changed_at LIKE ? GROUP BY run_id, src_type, product, platform ORDER BY n DESC",
            (f"{day}%",)).fetchall()
    print(f"{day} 被改过的产品：")
    for r in rows:
        print(f"  run={r['run_id']} [{r['src_type']}] {r['product']} {r['platform'] or ''}: {r['n']} 格")


def _same(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return abs(float(a) - float(b)) <= 1e-9
    except (TypeError, ValueError):
        return str(a) == str(b)


def cmd_rollback():
    rid = arg("run_id") or (sys.argv[2] if len(sys.argv) > 2 else None)
    with conn() as c:
        rows = c.execute("SELECT * FROM cell_changes WHERE run_id=? ORDER BY id", (rid,)).fetchall()
    # 同一格可能被写多次（例如 topon 先写单侧值、max 再写合计），回滚要以「本次运行前的值」为准：
    # 取该格最早一条的 old_value 作为回滚目标，最晚一条的 new_value 作为现值。
    merged = {}
    for r in rows:
        k = (r["doc_token"], r["sheet_id"], r["cell"])
        m = merged.get(k)
        if m is None:
            merged[k] = {"doc": r["doc_token"], "sheet": r["sheet_id"], "cell": r["cell"],
                         "metric": r["metric"], "old": r["old_value"], "new": r["new_value"],
                         "product": r["product"], "platform": r["platform"],
                         "src_type": r["src_type"], "writes": 1}
        else:
            m["new"] = r["new_value"]
            m["writes"] += 1
            if r["src_type"] != m["src_type"]:
                m["src_type"] += "+" + r["src_type"]
    plan = {}
    for m in merged.values():
        if _same(m["old"], m["new"]):
            continue  # 本批次净变化为 0（如 topon 写单侧值、max 又写回原值），无需回滚
        plan.setdefault((m["doc"], m["sheet"]), []).append(m)
    net0 = len(merged) - sum(len(v) for v in plan.values())
    if "--json" in sys.argv:
        print(json.dumps({f"{k[0]}|{k[1]}": v for k, v in plan.items()}, ensure_ascii=False, indent=1))
        return
    total = sum(len(v) for v in plan.values())
    print(f"运行 {rid} 的回滚清单（按格子聚合：old=本次运行前的值，new=现值；old 为空表示本次新增，回滚=清空）")
    print(f"需要回滚 {total} 格，涉及 {len(plan)} 个文档；另有 {net0} 格本批次净变化为 0，已略去\n")
    for (doc, sheet), items in plan.items():
        print(f"■ 文档 {doc} / 子表 {sheet}  —— {len(items)} 格")
        for it in items:
            back = it["old"] if it["old"] is not None else "(空)"
            twice = "" if it["writes"] == 1 else f"（本批次写过 {it['writes']} 次）"
            print(f"    {it['cell']:8s} {it['metric']:6s} 现值 {it['new']} → 回滚为 {back}"
                  f"   [{it['src_type']}] {it['product']} {it['platform'] or ''}{twice}")
    print("\n执行建议：先 dry-run 核对，再分批用 values_batch_update 写回；"
          "新增行（old 为空）如需整行删除请人工确认。")


CMDS = {"stats": cmd_stats, "runs": cmd_runs, "show": cmd_show, "changes": cmd_changes,
        "product": cmd_product, "changed-on": cmd_changed_on, "rollback": cmd_rollback}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    if cmd not in CMDS:
        print(__doc__)
    else:
        CMDS[cmd]()
