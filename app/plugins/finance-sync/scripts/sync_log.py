#!/usr/bin/env python3
"""同步审计日志（本地 SQLite）。

目的：每次更新都留痕，能回答三个问题——
  1) 这次跑了什么、成功没有（运行级 / 规则级）
  2) 具体改了哪个表哪个格子的值（单元格级：旧值 → 新值）
  3) 要回滚的话，需要把哪些格子写回什么（导出写回清单，人工执行）

设计原则（重要）：
  - 本地落盘，毫秒级、不依赖网络，绝不因为"写日志"拖慢或拖挂主同步流程；
  - 所有写入都包在 try/except 里，日志失败只告警、不抛异常；
  - topon/max/admob/consume 是并行子进程，共用一个 db 文件，
    因此开 WAL + busy timeout，避免 "database is locked"。

表结构：
  runs           每次运行一行（含触发方式、数据日、耗时、结果）
  steps          每个步骤一行（快照/各类型同步/大盘/卡片）
  rule_runs      每条规则每次运行一行（写了多少格、失败原因）
  cell_changes   单元格级变更（doc/sheet/单元格 / 旧值 / 新值）← 回滚靠这张
  dapan_changes  大盘表字段变更（旧值/新值）
  card_pushes    卡片推送记录

用法：
  python3 sync_log.py stats                     # 日志库概览
  python3 sync_log.py runs --limit 10           # 最近 N 次运行
"""
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SYNC_LOG_DB") or os.path.join(HERE, "sync_history.db")

# 跨机器中转用的飞书多维表格（双方都能访问的「消耗同步配置中心」base）
RELAY_BASE = os.environ.get("SYNC_RELAY_BASE") or "Nmc8b6FAxa62VZsQwIfck1Bcn9f"
RELAY_TABLE = os.environ.get("SYNC_RELAY_TABLE") or "tbls3Y2c0W1mUARe"
# 中转表字段（推送/拉取都按这些名字走）
RELAY_FIELDS = ["记录键", "记录类型", "机器", "运行ID", "时间", "步骤", "触发", "模式", "数据日", "结果", "备注",
                "规则类型", "产品", "平台", "文档", "子表", "单元格", "指标", "旧值", "新值",
                "写入格数", "跳过", "零值", "缺行", "失败原因"]

# 本地库增量迁移：老库补 machine / ext_key 两列（幂等）
MIGRATIONS = [(t, c, "TEXT") for t in ("runs", "steps", "rule_runs", "cell_changes",
                                       "dapan_changes", "card_pushes")
              for c in ("machine", "ext_key")]

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    trigger     TEXT,               -- auto / manual / full_review / rollback
    argv        TEXT,
    mode        TEXT,               -- full(全量) / partial(定向) / dry
    data_day    TEXT,               -- 数据日（大盘最新数据日）
    ok          INTEGER,
    note        TEXT
);
CREATE TABLE IF NOT EXISTS steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    step       TEXT NOT NULL,       -- snapshot / sync:topon / sync:max / sync:admob / sync:consume / dapan / card
    started_at TEXT,
    finished_at TEXT,
    exit_code  INTEGER,
    ok         INTEGER,
    summary    TEXT
);
CREATE TABLE IF NOT EXISTS rule_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,
    src_type       TEXT,            -- topon / max / admob / consume
    product        TEXT,
    platform       TEXT,
    doc_token      TEXT,
    sheet_id       TEXT,
    ok             INTEGER,
    wrote          INTEGER DEFAULT 0,
    skipped        INTEGER DEFAULT 0,
    zero_skipped   INTEGER DEFAULT 0,
    missing_rows   INTEGER DEFAULT 0,
    est_cells      INTEGER DEFAULT 0,
    api_cells      INTEGER DEFAULT 0,
    overlay_cells  INTEGER DEFAULT 0,
    history_skip   INTEGER DEFAULT 0,
    error          TEXT
);
CREATE TABLE IF NOT EXISTS cell_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    changed_at  TEXT,
    src_type    TEXT,
    product     TEXT,
    platform    TEXT,
    doc_token   TEXT,
    sheet_id    TEXT,
    cell        TEXT,               -- 例如 F177
    metric      TEXT,               -- 收益 / 展示 / ecpm / 请求 / 消耗 / 安装 / 日期
    old_value   TEXT,
    new_value   TEXT
);
CREATE TABLE IF NOT EXISTS dapan_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    changed_at TEXT,
    product    TEXT,
    platform   TEXT,
    field      TEXT,
    old_value  TEXT,
    new_value  TEXT
);
CREATE TABLE IF NOT EXISTS card_pushes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT,
    sent_at  TEXT,
    target   TEXT,
    ok       INTEGER,
    detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rule_runs_run   ON rule_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_rule_runs_prod  ON rule_runs(product, platform);
CREATE INDEX IF NOT EXISTS idx_cell_run        ON cell_changes(run_id);
CREATE INDEX IF NOT EXISTS idx_cell_prod       ON cell_changes(product, platform);
CREATE INDEX IF NOT EXISTS idx_cell_doc        ON cell_changes(doc_token);
CREATE INDEX IF NOT EXISTS idx_dapan_run       ON dapan_changes(run_id);
"""


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=20000")
    except sqlite3.Error:
        pass
    return conn


def init():
    with _conn() as c:
        c.executescript(SCHEMA)
        # 幂等迁移：老库补 machine / ext_key 列（跨机器去重要用）
        for table, col, typ in MIGRATIONS:
            cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        c.executescript("CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_key ON cell_changes(ext_key);"
                        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_key_run ON runs(ext_key);")
    return DB_PATH


def machine_id():
    """本机标识：可用环境变量 SYNC_MACHINE 覆盖（建议同事那台设成他的名字，便于区分）。"""
    return os.environ.get("SYNC_MACHINE") or socket.gethostname().split(".")[0]


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _j(v):
    """单元格旧/新值统一存字符串；None 存成 NULL。"""
    if v is None:
        return None
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v)


def _safe(fn, *a, **kw):
    """日志失败绝不能影响主流程。"""
    try:
        return fn(*a, **kw)
    except Exception as e:
        print(f"[sync_log] 写日志失败（忽略）: {e}")
        return None


# ---------------- 运行级 ----------------

def current_run_id():
    return os.environ.get("SYNC_RUN_ID") or None


def new_run(trigger="auto", argv="", mode="full", data_day=None):
    """开一次运行记录，返回 run_id；同时写入环境变量供子进程复用。"""
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        init()
        with _conn() as c:
            n = 0
            base = run_id
            while c.execute("SELECT 1 FROM runs WHERE run_id=?", (run_id,)).fetchone():
                n += 1
                run_id = f"{base}-{n}"
            c.execute(
                "INSERT INTO runs(run_id, started_at, trigger, argv, mode, data_day, machine, ext_key)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (run_id, _now(), trigger, argv, mode, data_day,
                 machine_id(), f"{machine_id()}|{run_id}|run"))
    except Exception as e:
        print(f"[sync_log] 建运行记录失败（忽略）: {e}")
    os.environ["SYNC_RUN_ID"] = run_id
    return run_id


def finish_run(run_id=None, ok=True, note=None, data_day=None):
    run_id = run_id or current_run_id()
    if not run_id:
        return

    def _do():
        with _conn() as c:
            if data_day:
                c.execute("UPDATE runs SET finished_at=?, ok=?, note=?, data_day=? WHERE run_id=?",
                          (_now(), 1 if ok else 0, note, data_day, run_id))
            else:
                c.execute("UPDATE runs SET finished_at=?, ok=?, note=? WHERE run_id=?",
                          (_now(), 1 if ok else 0, note, run_id))
    _safe(_do)


def set_data_day(day, run_id=None):
    """记录本次运行对应的数据日（由 dapan 汇总阶段回填）。"""
    run_id = run_id or current_run_id()
    if not run_id:
        return

    def _do():
        with _conn() as c:
            c.execute("UPDATE runs SET data_day=? WHERE run_id=?", (day, run_id))
    _safe(_do)


def log_step(step, ok=True, exit_code=None, started_at=None, finished_at=None, summary=None, run_id=None):
    run_id = run_id or current_run_id()
    if not run_id:
        return

    def _do():
        with _conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO steps(run_id, step, started_at, finished_at, exit_code, ok, summary,"
                " machine, ext_key) VALUES (?,?,?,?,?,?,?,?,?)",
                (run_id, step, started_at, finished_at or _now(), exit_code,
                 1 if ok else 0, (summary or "")[:900], machine_id(),
                 f"{machine_id()}|{run_id}|step|{step}"))
    _safe(_do)


# ---------------- 规则级 + 单元格级 ----------------

def log_rule_results(results, run_id=None, changed_at=None):
    """results = full_review.py 的逐规则结果列表。返回落库的规则数 / 变更格数。"""
    run_id = run_id or current_run_id()
    if not run_id or not results:
        return 0, 0
    changed_at = changed_at or _now()
    machine = machine_id()
    rules, cells = [], []
    for r in results:
        plat = r.get("平台") or r.get("platform") or ""
        rules.append((
            run_id, r.get("src_type"), r.get("name"), r.get("平台") or r.get("platform"),
            r.get("doc"), r.get("sheet"), 1 if r.get("ok") else 0,
            r.get("写", 0), r.get("跳过", 0), r.get("零值", 0), r.get("缺行", 0),
            r.get("预估", 0), r.get("API", 0), r.get("叠加写", 0), r.get("跳历史", 0),
            (r.get("err") or "")[:900], machine,
            f"{machine}|{run_id}|rule|{r.get('src_type')}|{r.get('name')}|{plat}"))
        for k, ch in enumerate(r.get("changes", []) or []):
            cells.append((run_id, changed_at, r.get("src_type"), r.get("name"),
                          r.get("平台") or r.get("platform"), r.get("doc"), r.get("sheet"),
                          ch.get("cell"), ch.get("metric"), _j(ch.get("old")), _j(ch.get("new")),
                          machine,
                          f"{machine}|{run_id}|cell|{r.get('src_type')}|{r.get('name')}|{ch.get('cell')}|{ch.get('metric')}|{k}"))

    def _do():
        with _conn() as c:
            c.executemany(
                "INSERT OR IGNORE INTO rule_runs(run_id,src_type,product,platform,doc_token,sheet_id,ok,"
                "wrote,skipped,zero_skipped,missing_rows,est_cells,api_cells,overlay_cells,history_skip,error,"
                "machine,ext_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rules)
            if cells:
                c.executemany(
                    "INSERT OR IGNORE INTO cell_changes(run_id,changed_at,src_type,product,platform,"
                    "doc_token,sheet_id,cell,metric,old_value,new_value,machine,ext_key)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", cells)
    _safe(_do)
    return len(rules), len(cells)


def log_dapan_changes(changes, run_id=None, changed_at=None):
    """changes = [{product, platform, field, old, new}]"""
    run_id = run_id or current_run_id()
    if not run_id or not changes:
        return 0
    changed_at = changed_at or _now()
    machine = machine_id()
    rows = [(run_id, changed_at, c.get("product"), c.get("platform"), c.get("field"),
             _j(c.get("old")), _j(c.get("new")), machine,
             f"{machine}|{run_id}|dapan|{c.get('product')}|{c.get('platform')}|{c.get('field')}")
            for c in changes]

    def _do():
        with _conn() as c:
            c.executemany(
                "INSERT OR IGNORE INTO dapan_changes(run_id,changed_at,product,platform,field,"
                "old_value,new_value,machine,ext_key) VALUES (?,?,?,?,?,?,?,?,?)", rows)
    _safe(_do)
    return len(rows)


def log_card(target, ok=True, detail=None, run_id=None):
    run_id = run_id or current_run_id()

    def _do():
        with _conn() as c:
            n = c.execute("SELECT COUNT(*) FROM card_pushes WHERE run_id=?", (run_id,)).fetchone()[0]
            c.execute("INSERT OR IGNORE INTO card_pushes(run_id, sent_at, target, ok, detail, machine, ext_key)"
                      " VALUES (?,?,?,?,?,?,?)",
                      (run_id, _now(), target, 1 if ok else 0, (detail or "")[:500], machine_id(),
                       f"{machine_id()}|{run_id}|card|{target}|{n}"))
    _safe(_do)


# ---------------- 查询 / 回滚清单 ----------------

def rollback_plan(run_id):
    """导出某次运行的写回清单：[{doc, sheet, cell, metric, product, old, new}]"""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM cell_changes WHERE run_id=? ORDER BY doc_token, sheet_id, id",
            (run_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------- 跨机器中转（飞书中转表） ----------------

from codex_lark_adapter import cli_command, cli_error


def _cli(args):
    p = subprocess.run(cli_command(args), capture_output=True, text=True)
    if p.returncode != 0:
        raise cli_error(p)
    raw = (p.stdout or p.stderr or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "raw": raw[:300]}


def _cell(v):
    """Base 读回来的单元格：单选/多选是列表，用户/链接是字典——统一取成标量。"""
    if isinstance(v, list):
        if not v:
            return None
        first = v[0]
        if isinstance(first, dict):
            return first.get("text") or first.get("name") or first.get("id")
        return first
    if isinstance(v, dict):
        return v.get("text") or v.get("name") or v.get("id")
    return v


def _relay_list(base, table, fields, limit=200):
    """分页读中转表，返回 [{字段: 值}]（值已归一化为标量）。"""
    out, offset = [], 0
    while True:
        args = ["base", "+record-list", "--base-token", base, "--table-id", table,
                "--offset", str(offset), "--limit", str(limit), "--format", "json", "--as", "user"]
        for f in fields:
            args += ["--field-id", f]
        d = _cli(args)
        if not d.get("ok"):
            print(f"[中转] 读取失败: {json.dumps(d, ensure_ascii=False)[:250]}")
            break
        data = d.get("data") or {}
        names = data.get("fields") or []
        for row in data.get("data") or []:
            out.append({n: _cell(row[i] if i < len(row) else None) for i, n in enumerate(names)})
        if not data.get("has_more") or not (data.get("data") or []):
            break
        offset += len(data.get("data") or [])
        time.sleep(0.2)
    return out


def relay_rows_for_run(run_id=None):
    """把某次运行在本地库的全部记录整理成中转表的扁平行。"""
    run_id = run_id or current_run_id()
    out = []
    with _conn() as c:
        r = c.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if not r:
            return out
        mach = r["machine"] or machine_id()
        res = "成功" if r["ok"] else ("有失败" if r["ok"] is not None else "进行中")
        out.append({"记录键": r["ext_key"] or f"{mach}|{run_id}|run", "记录类型": "运行", "机器": mach,
                    "运行ID": run_id, "时间": r["started_at"], "触发": r["trigger"] or "",
                    "模式": r["mode"] or "", "数据日": r["data_day"] or "", "结果": res,
                    "备注": (r["note"] or "")[:400]})
        for s in c.execute("SELECT * FROM steps WHERE run_id=? ORDER BY id", (run_id,)):
            out.append({"记录键": s["ext_key"] or f"{mach}|{run_id}|step|{s['step']}", "记录类型": "步骤",
                        "机器": mach, "运行ID": run_id, "时间": s["finished_at"] or s["started_at"] or "",
                        "步骤": s["step"] or "", "结果": "成功" if s["ok"] else "失败",
                        "备注": (s["summary"] or "")[:400],
                        "失败原因": "" if s["ok"] else f"exit={s['exit_code']}"})
        for x in c.execute("SELECT * FROM rule_runs WHERE run_id=? ORDER BY id", (run_id,)):
            out.append({"记录键": x["ext_key"] or f"{mach}|{run_id}|rule|{x['src_type']}|{x['product']}|"
                                                    f"{x['platform'] or ''}",
                        "记录类型": "规则", "机器": mach, "运行ID": run_id, "结果": "成功" if x["ok"] else "失败",
                        "规则类型": x["src_type"] or "", "产品": x["product"] or "",
                        "平台": x["platform"] or "", "文档": x["doc_token"] or "", "子表": x["sheet_id"] or "",
                        "写入格数": x["wrote"], "跳过": x["skipped"], "零值": x["zero_skipped"],
                        "缺行": x["missing_rows"], "失败原因": (x["error"] or "")[:400]})
        for x in c.execute("SELECT * FROM cell_changes WHERE run_id=? ORDER BY id", (run_id,)):
            out.append({"记录键": x["ext_key"] or f"{mach}|{run_id}|cell|{x['id']}", "记录类型": "单元格", "机器": mach, "运行ID": run_id,
                        "时间": x["changed_at"] or "", "规则类型": x["src_type"] or "",
                        "产品": x["product"] or "", "平台": x["platform"] or "",
                        "文档": x["doc_token"] or "", "子表": x["sheet_id"] or "",
                        "单元格": x["cell"] or "", "指标": x["metric"] or "",
                        "旧值": x["old_value"], "新值": x["new_value"]})
        for x in c.execute("SELECT * FROM dapan_changes WHERE run_id=? ORDER BY id", (run_id,)):
            out.append({"记录键": x["ext_key"] or f"{mach}|{run_id}|dapan|{x['id']}", "记录类型": "大盘", "机器": mach, "运行ID": run_id,
                        "时间": x["changed_at"] or "", "产品": x["product"] or "",
                        "平台": x["platform"] or "", "指标": x["field"] or "",
                        "旧值": x["old_value"], "新值": x["new_value"]})
        for x in c.execute("SELECT * FROM card_pushes WHERE run_id=? ORDER BY id", (run_id,)):
            out.append({"记录键": x["ext_key"] or f"{mach}|{run_id}|card|{x['id']}", "记录类型": "卡片", "机器": mach, "运行ID": run_id,
                        "时间": x["sent_at"] or "", "结果": "成功" if x["ok"] else "失败",
                        "指标": x["target"] or "", "备注": (x["detail"] or "")[:200]})
    return out


def push_run(run_id=None, base=None, table=None, dry=False):
    """把某次运行的全部记录推到飞书中转表（按记录键去重）。返回实际推送条数。"""
    run_id = run_id or current_run_id()
    base, table = base or RELAY_BASE, table or RELAY_TABLE
    rows = relay_rows_for_run(run_id)
    if not rows:
        print(f"[中转] 本地库没有运行 {run_id} 的记录")
        return 0
    have = {str(r.get("记录键")) for r in _relay_list(base, table, ["记录键"])}
    todo = [r for r in rows if str(r.get("记录键")) not in have]
    print(f"[中转] 运行 {run_id}: 本地 {len(rows)} 条，中转表已有 {len(rows) - len(todo)} 条，待推 {len(todo)} 条")
    if dry or not todo:
        return 0
    pushed = 0
    for i in range(0, len(todo), 200):
        chunk = todo[i:i + 200]
        d = _cli(["base", "+record-batch-create", "--base-token", base, "--table-id", table,
                  "--json", json.dumps({"create_records": chunk}, ensure_ascii=False),
                  "--format", "json", "--as", "user"])
        if not d.get("ok"):
            print(f"[中转] 推送失败（已推 {pushed} 条）: {json.dumps(d, ensure_ascii=False)[:300]}")
            return pushed
        pushed += len(chunk)
        time.sleep(0.3)
    print(f"[中转] 已推送 {pushed} 条")
    return pushed


def pull_relay(base=None, table=None, dry=False, verbose=True):
    """把中转表里别的机器推上来的记录拉到本地库（按记录键去重）。返回新增条数。"""
    base, table = base or RELAY_BASE, table or RELAY_TABLE
    rows = _relay_list(base, table, RELAY_FIELDS)
    if verbose:
        print(f"[中转] 中转表共 {len(rows)} 条记录")
    mine = set()
    with _conn() as c:
        for t in ("runs", "steps", "rule_runs", "cell_changes", "dapan_changes", "card_pushes"):
            mine |= {x["ext_key"] for x in c.execute(f"SELECT ext_key FROM {t} WHERE ext_key IS NOT NULL")}
    new = [r for r in rows if str(r.get("记录键")) not in mine]
    if not new:
        if verbose:
            print("[中转] 没有新记录")
        return 0
    if dry:
        print(f"[中转] 待拉取 {len(new)} 条（dry-run，不写入）")
        return 0

    def _s(v):
        return None if v in (None, "") else str(v)

    def _n(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0

    runs, steps, rules, cells, dapan, cards = [], [], [], [], [], []
    for r in new:
        mach = str(r.get("机器") or "unknown")
        rid = f"{mach}@{r.get('运行ID')}"  # 加机器前缀，避免与本地 run_id 撞主键
        kind = str(r.get("记录类型") or "")
        key = r.get("记录键")
        if kind == "运行":
            runs.append((rid, _s(r.get("时间")) or _now(), _s(r.get("触发")), _s(r.get("模式")),
                         _s(r.get("数据日")),
                         "成功" if r.get("结果") == "成功" else ("有失败" if r.get("结果") == "有失败" else None),
                         _s(r.get("备注")), mach, key))
        elif kind == "步骤":
            t = _s(r.get("时间"))
            m = re.search(r"exit=(-?\d+)", str(r.get("失败原因") or ""))
            steps.append((rid, _s(r.get("步骤")) or "step", t, t, int(m.group(1)) if m else None,
                          1 if r.get("结果") == "成功" else 0, _s(r.get("备注")), mach, key))
        elif kind == "规则":
            rules.append((rid, _s(r.get("规则类型")), _s(r.get("产品")), _s(r.get("平台")),
                          _s(r.get("文档")), _s(r.get("子表")), 1 if r.get("结果") == "成功" else 0,
                          _n(r.get("写入格数")), _n(r.get("跳过")), _n(r.get("零值")), _n(r.get("缺行")),
                          _s(r.get("失败原因")), mach, key))
        elif kind == "单元格":
            cells.append((rid, _s(r.get("时间")), _s(r.get("规则类型")), _s(r.get("产品")), _s(r.get("平台")),
                          _s(r.get("文档")), _s(r.get("子表")), _s(r.get("单元格")), _s(r.get("指标")),
                          _s(r.get("旧值")), _s(r.get("新值")), mach, key))
        elif kind == "大盘":
            dapan.append((rid, _s(r.get("时间")), _s(r.get("产品")), _s(r.get("平台")), _s(r.get("指标")),
                          _s(r.get("旧值")), _s(r.get("新值")), mach, key))
        elif kind == "卡片":
            cards.append((rid, _s(r.get("时间")), _s(r.get("指标")) or "group",
                          1 if r.get("结果") == "成功" else 0, _s(r.get("备注")), mach, key))

    with _conn() as c:
        if runs:
            c.executemany("INSERT OR IGNORE INTO runs(run_id, started_at, trigger, mode, data_day, ok, note,"
                          " machine, ext_key) VALUES (?,?,?,?,?,?,?,?,?)", runs)
        if steps:
            c.executemany("INSERT OR IGNORE INTO steps(run_id, step, started_at, finished_at, exit_code, ok,"
                          " summary, machine, ext_key) VALUES (?,?,?,?,?,?,?,?,?)", steps)
        if rules:
            c.executemany("INSERT OR IGNORE INTO rule_runs(run_id,src_type,product,platform,doc_token,sheet_id,"
                          "ok,wrote,skipped,zero_skipped,missing_rows,error,machine,ext_key)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rules)
        if cells:
            c.executemany("INSERT OR IGNORE INTO cell_changes(run_id,changed_at,src_type,product,platform,"
                          "doc_token,sheet_id,cell,metric,old_value,new_value,machine,ext_key)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", cells)
        if dapan:
            c.executemany("INSERT OR IGNORE INTO dapan_changes(run_id,changed_at,product,platform,field,"
                          "old_value,new_value,machine,ext_key) VALUES (?,?,?,?,?,?,?,?,?)", dapan)
        if cards:
            c.executemany("INSERT OR IGNORE INTO card_pushes(run_id, sent_at, target, ok, detail, machine,"
                          " ext_key) VALUES (?,?,?,?,?,?,?)", cards)
    if verbose:
        by = {}
        for r in new:
            by[str(r.get("机器") or "?")] = by.get(str(r.get("机器") or "?"), 0) + 1
        print(f"[中转] 新增 {len(new)} 条（运行 {len(runs)} / 规则 {len(rules)} / 单元格 {len(cells)}"
              f" / 大盘 {len(dapan)} / 卡片 {len(cards)}）；来源机器: {by}")
    return len(new)


def stats():
    with _conn() as c:
        q = lambda s: c.execute(s).fetchone()[0]
        out = {
            "db": DB_PATH,
            "runs": q("SELECT COUNT(*) FROM runs"),
            "rule_runs": q("SELECT COUNT(*) FROM rule_runs"),
            "cell_changes": q("SELECT COUNT(*) FROM cell_changes"),
            "dapan_changes": q("SELECT COUNT(*) FROM dapan_changes"),
            "card_pushes": q("SELECT COUNT(*) FROM card_pushes"),
            "first_run": q("SELECT MIN(started_at) FROM runs"),
            "last_run": q("SELECT MAX(started_at) FROM runs"),
        }
    return out


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "stats"
    if cmd == "stats":
        init()
        for k, v in stats().items():
            print(f"  {k}: {v}")
    elif cmd == "runs":
        limit = 10
        if "--limit" in args:
            limit = int(args[args.index("--limit") + 1])
        with _conn() as c:
            rows = c.execute(
                "SELECT run_id, started_at, finished_at, trigger, mode, data_day, ok FROM runs"
                " ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
        for r in rows:
            print(f"  {r['run_id']}  {r['started_at']} → {r['finished_at']}  {r['trigger']}/{r['mode']}"
                  f"  数据日={r['data_day']}  {'成功' if r['ok'] else '有失败'}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
