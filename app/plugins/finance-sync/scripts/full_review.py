#!/usr/bin/env python3
"""全量复核更新：按规则把源表最新数据写入目标表，并回写运行状态。
口径：API列有值用API，否则用预估；数值纯数字写入；目标缺日期行自动补行。
用法: python3 full_review.py [--dry] [--only 产品名关键词] [--dates YYYY-MM-DD,YYYY-MM-DD]
"""
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

from codex_lark_adapter import update_records
import sync_log
from sync_dates import date_serial, parse_dates

from codex_lark_adapter import cli_command, cli_error
BASE = "Nmc8b6FAxa62VZsQwIfck1Bcn9f"          # 消耗同步配置中心（消耗规则表）
AD_BASE = "RrB6bBje3acplSsE2mscswkhnDF"       # 广告同步规则（topon / max 规则表，独立 base）
# 规则类型 -> (base_token, table_id)，状态回写时按此定位
TABLES = {"topon": (AD_BASE, "tbluixPbjbNY5Z6Y"),
          "max": (AD_BASE, "tblSlhf6YYwmJmo7"),
          "admob": (AD_BASE, "tblu5mcci8wpDJqL"),
          "consume": (BASE, "tbldtJZblqwpuO9w")}


def run(args):
    for _ in range(3):
        p = subprocess.run(cli_command(args), capture_output=True, text=True)
        if p.returncode != 0:
            raise cli_error(p)
        raw = (p.stdout or p.stderr or "").strip()
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        time.sleep(1)
    return {}


def txt(v):
    if isinstance(v, list) and v:
        x = v[0]
        return str(x.get("text", x)) if isinstance(x, dict) else str(x)
    if isinstance(v, dict):
        return str(v.get("link") or v.get("text") or "")
    return "" if v is None else str(v)


def col_to_idx(col):
    n = 0
    for ch in col.strip().upper():
        if "A" <= ch <= "Z":
            n = n * 26 + (ord(ch) - 64)
    return n


def idx_to_col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def num(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.replace("$", "").replace(",", "").strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def resolve_obj(url, cache):
    if url in cache:
        return cache[url]
    m = re.search(r"/(?:wiki|sheets)/([A-Za-z0-9]+)", url or "")
    obj = None
    if m and "/wiki/" in url:
        d = run(["api", "GET", "/open-apis/wiki/v2/spaces/get_node",
                 "--params", json.dumps({"token": m.group(1), "obj_type": "wiki"})])
        obj = ((d.get("data") or {}).get("node") or {}).get("obj_token")
    elif m:
        obj = m.group(1)
    cache[url] = obj
    return obj


def get_values(obj, rng):
    d = run(["api", "GET", f"/open-apis/sheets/v2/spreadsheets/{obj}/values/{rng}",
             "--params", json.dumps({"valueRenderOption": "UnformattedValue"})])
    return (d.get("data") or {}).get("valueRange", {}).get("values") or []


def pick_sheet(obj, match, cache):
    # sheets/query 偶发返回错误/空（限流或瞬时故障）。以前会把空结果写进缓存并整轮沿用，
    # 导致该文档下的规则全部报「目标子表未找到」。现在：失败重试一次，且不缓存空结果。
    if not cache.get(obj):
        sheets = []
        for _ in range(3):
            try:
                d = run(["api", "GET", f"/open-apis/sheets/v3/spreadsheets/{obj}/sheets/query"])
                sheets = [(s["title"], s["sheet_id"]) for s in (d.get("data") or {}).get("sheets", [])]
            except Exception:
                sheets = []
            if sheets:
                break
            time.sleep(0.6)
        if sheets:
            cache[obj] = sheets
    sheets = cache.get(obj) or []
    for t, s in sheets:
        if match and match in t:
            return s
    return sheets[0][1] if sheets else None


def load_sources(rules):
    """按规则里的源表配置加载源数据。"""
    obj_cache = {}
    src = {"topon": defaultdict(dict), "max": defaultdict(dict),
           "admob": defaultdict(dict), "consume": defaultdict(dict)}
    loaded = set()
    for r in rules:
        f = r["fields"]
        if not f.get("启用"):
            continue
        src_url = txt(f.get("源表URL"))
        src_sid = txt(f.get("源子表ID"))
        if not src_url or not src_sid or (src_url, src_sid) in loaded:
            continue
        loaded.add((src_url, src_sid))
        obj = resolve_obj(src_url, obj_cache)
        if not obj:
            print("源表无法解析:", src_url)
            continue
        src_range = {"0uKWKA": "A2:Q60000", "X49V9l": "A2:G60000",
                     "7VsXJh": "A2:J60000", "9vFTyb": "A2:H60000"}.get(src_sid, "A2:Q60000")
        rows = get_values(obj, f"{src_sid}!{src_range}")
        print(f"源表 {src_sid}: {len(rows)} 行")
        for row in rows:
            if not row or not isinstance(row[0], (int, float)):
                continue
            serial = int(row[0])
            if src_sid == "0uKWKA":  # topon
                app, plat = txt(row[2] if len(row) > 2 else ""), txt(row[1] if len(row) > 1 else "")
                if not app:
                    continue
                k = (app, plat, serial)
                src["topon"][k] = {
                    "预估收益": num(row[5]) if len(row) > 5 else None,
                    "API收益": num(row[6]) if len(row) > 6 else None,
                    "预估展示": num(row[11]) if len(row) > 11 else None,
                    "API展示": num(row[12]) if len(row) > 12 else None,
                    "预估ecpm": num(row[15]) if len(row) > 15 else None,
                    "APIecpm": num(row[16]) if len(row) > 16 else None,
                }
            elif src_sid == "X49V9l":  # max
                app = txt(row[1] if len(row) > 1 else "")
                if not app:
                    continue
                src["max"][(app, serial)] = {
                    "请求": num(row[3]) if len(row) > 3 else None,
                    "展示": num(row[4]) if len(row) > 4 else None,
                    "收益": num(row[5]) if len(row) > 5 else None,
                    "ecpm": num(row[6]) if len(row) > 6 else None,
                }
            elif src_sid == "7VsXJh":  # admob：B=App C=Type(平台) D=收益 E=eCPM F=请求 J=展示
                app, plat = txt(row[1] if len(row) > 1 else ""), txt(row[2] if len(row) > 2 else "")
                if not app:
                    continue
                src["admob"][(app, plat, serial)] = {
                    "收益": num(row[3]) if len(row) > 3 else None,
                    "ecpm": num(row[4]) if len(row) > 4 else None,
                    "请求": num(row[5]) if len(row) > 5 else None,
                    "展示": num(row[9]) if len(row) > 9 else None,
                }
            elif src_sid == "9vFTyb":  # 网赚消耗
                app = txt(row[1] if len(row) > 1 else "")
                if not app:
                    continue
                src["consume"][(app, serial)] = {
                    "消耗": num(row[6]) if len(row) > 6 else None,
                    "安装": num(row[7]) if len(row) > 7 else None,
                }
    return src


TARGET_ROWS_CACHE = {}


def target_sheet_rows(obj, sid):
    """带缓存读取目标表；同文档多规则共用一次读取（写入后由 invalidate_target 失效）。"""
    key = (obj, sid)
    if key not in TARGET_ROWS_CACHE:
        TARGET_ROWS_CACHE[key] = get_values(obj, f"{sid}!A1:CZ800")
    return TARGET_ROWS_CACHE[key]


def invalidate_target(obj, sid):
    TARGET_ROWS_CACHE.pop((obj, sid), None)


def prewarm_targets(rules, obj_cache, sheet_cache, workers=12):
    """并行预读本轮的 90+ 张目标表。

    同步阶段最耗时的一步是逐条规则读目标表（每条一次 lark-cli 子进程），
    这里并发拉取，主循环随后全部命中缓存。读并发、写仍然串行，数据口径不变。
    """
    pairs = []
    for r in rules:
        u = txt(r["fields"].get("目标表URL"))
        if u:
            pairs.append((u, txt(r["fields"].get("目标子表匹配"))))
    todo = sorted(set(pairs))

    def work(pair):
        url, hint = pair
        try:
            obj = resolve_obj(url, obj_cache)
            if not obj:
                return
            sid = pick_sheet(obj, hint, sheet_cache)
            if sid:
                target_sheet_rows(obj, sid)
        except Exception:
            pass

    print(f"   并行预读 {len(todo)} 张目标表（{workers} 线程）...")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for count, _ in enumerate(ex.map(work, todo), 1):
            if count % 20 == 0 or count == len(todo):
                print(f"   预读进度: {count}/{len(todo)}", flush=True)
    print(f"   预读完成，用时 {time.time() - t0:.0f}s，已缓存 {len(TARGET_ROWS_CACHE)} 张表")


def target_date_rows(rows, date_ci):
    """返回 {serial: row_index} 及最大行号。"""
    m = {}
    for ri, row in enumerate(rows):
        v = row[date_ci] if date_ci < len(row) else None
        if isinstance(v, (int, float)) and 45000 < v < 47000:
            m[int(v)] = ri
    return m


def close(a, b):
    if a is None or b is None:
        return False
    return abs(a - b) <= max(1e-6, abs(a) * 1e-6)


EXCEL_EPOCH = date(1899, 12, 30)


def today_serial():
    """今天的电子表格日期序列号（本地时区，Asia/Shanghai）。"""
    return (date.today() - EXCEL_EPOCH).days


def pick_metric(d, est_k, api_k, use_est):
    """按指定口径取值：use_est=True 取预估、False 取 API；该侧缺失时回退另一侧，避免空写。"""
    if use_est:
        if d.get(est_k) is not None:
            return d.get(est_k), "预估"
        return (d.get(api_k), "API") if d.get(api_k) is not None else (None, None)
    if d.get(api_k) is not None:
        return d.get(api_k), "API"
    return (d.get(est_k), "预估") if d.get(est_k) is not None else (None, None)


PLAT_SUFFIX = re.compile(r"^(.*?)\s*\((Android|iOS)\)\s*$", re.I)


def serial_of(value):
    """把规则里的日期字段解析成电子表格序列号；支持毫秒时间戳与 'YYYY-MM-DD' 文本。"""
    if isinstance(value, (int, float)):
        try:
            return (datetime.fromtimestamp(value / 1000).date() - EXCEL_EPOCH).days
        except (ValueError, OSError, OverflowError):
            return None
    if isinstance(value, str) and value.strip():
        s = value.strip().replace("/", "-")[:10]
        try:
            return (datetime.strptime(s, "%Y-%m-%d").date() - EXCEL_EPOCH).days
        except ValueError:
            return None
    return None


def date_of_serial(serial):
    """电子表格日期序列号 -> 'YYYY-MM-DD'（仅用于状态说明展示）。"""
    try:
        return (EXCEL_EPOCH + timedelta(days=int(serial))).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return ""


def split_app_plat(s):
    """从 max 源应用名解析 (应用名, 平台)，如 'Art Story: Jigsaw HD (iOS)' -> ('Art Story: Jigsaw HD','iOS')。

    用于「叠加 topon」时定位 topon 源表里的同一应用同一天记录。
    """
    m = PLAT_SUFFIX.match(s or "")
    if m:
        return m.group(1).strip(), ("iOS" if m.group(2).lower() == "ios" else "Android")
    return (s or "").strip(), None


def process_rule(rec, src, obj_cache, sheet_cache, dry, topon_by_name=None, overlay_by_name=None,
                 overlay_cols=None, overlay_starts=None, selected_dates=None):
    f = rec["fields"]
    name = txt(f.get("产品名"))
    src_type = rec["src_type"]
    result = {"record_id": rec["record_id"], "src_type": src_type, "name": name,
              "写": 0, "跳过": 0, "零值": 0, "缺行": 0, "预估": 0, "API": 0, "ok": True, "err": "", "平台": txt(f.get("平台"))}
    if selected_dates is not None:
        result.update(dates=selected_dates, changes=[])
    url = txt(f.get("目标表URL"))
    obj = resolve_obj(url, obj_cache)
    if not obj:
        result.update(ok=False, err="目标URL无法解析")
        return result
    sid = pick_sheet(obj, txt(f.get("目标子表匹配")), sheet_cache)
    if not sid:
        result.update(ok=False, err="目标子表未找到")
        return result
    rows = target_sheet_rows(obj, sid)
    date_ci = col_to_idx(txt(f.get("目标日期列")) or "A") - 1
    dmap = target_date_rows(rows, date_ci)
    max_row = max(dmap.values()) if dmap else 1

    # 该规则要写的指标: [(写入列, 取值函数)]
    overlay, ov_app, ov_plat, ov_est, ov_from = False, None, None, False, None
    # ef_from：本叠加源（max/admob）自身的「生效起始日」，早于该日期的历史不写。
    # hand_off_from：同产品的叠加源全部填了「生效起始日」时，topon 规则只维护该日之前的历史。
    ef_from = None
    hand_off_from = (overlay_starts or {}).get(name)
    if src_type == "topon":
        app, plat = txt(f.get("源应用名")) or name, txt(f.get("平台"))
        keys = [(s, src["topon"].get((app, plat, s))) for s in
                sorted({k[2] for k in src["topon"] if k[0] == app and k[1] == plat})]
        # 若该产品还有 max/admob 叠加规则，则这几列（收益/展示/eCPM）由叠加规则统一写「合计」，
        # 本规则不再写——否则每次运行都会先写单侧值、随即被叠加规则覆盖（无谓写入 + 中间态）。
        # 例外：叠加源填了「生效起始日」时，双方是互补区间（之前归 topon、之后归叠加源），
        # 此时 topon 规则继续维护历史，不交出这几列。
        handed_cols = set() if hand_off_from is not None else (overlay_cols or {}).get(name, set())
        handed = []
        metrics = []
        for label, col_f, est_k, api_k in [("收益", "收益写入列", "预估收益", "API收益"),
                                           ("展示", "展示写入列", "预估展示", "API展示"),
                                           ("ecpm", "ecpm写入列", "预估ecpm", "APIecpm")]:
            col = txt(f.get(col_f))
            if not col:
                continue
            ci = col_to_idx(col) - 1
            if ci in handed_cols:
                handed.append(label)
                continue
            metrics.append((ci, est_k, api_k, label))
        if handed:
            result["交给叠加"] = handed
        get_val = lambda d, est_k, api_k: ((d.get(api_k), "API") if d.get(api_k) is not None else (d.get(est_k), "预估")) if d else (None, None)
    elif src_type == "max":
        app = txt(f.get("源应用名")) or name
        keys = [(s, src["max"].get((app, s))) for s in
                sorted({k[1] for k in src["max"] if k[0] == app})]
        metrics = [(col_to_idx(txt(f.get(c))) - 1, k, k, k) for c, k in
                   [("收益写入列", "收益"), ("展示写入列", "展示"), ("ecpm写入列", "ecpm"),
                    ("请求写入列", "请求")] if txt(f.get(c))]
        get_val = lambda d, est_k, api_k: ((d.get(est_k), "API") if d and d.get(est_k) is not None else (None, None))
        # 叠加 topon：收益列写 MAX收益 + topon收益（同应用同平台同日，topon 侧沿用预估优先口径）
        overlay = bool(f.get("叠加topon收益")) or bool(f.get("叠加topon"))
        ov_app, ov_plat = split_app_plat(app)
        # ov_est：同一产品的 topon 规则若勾了「始终用预估」，叠加时 topon 侧也一律取预估列
        ov_est = bool(((topon_by_name or {}).get(name) or {}).get("始终用预估"))
        # ov_from：同一产品 topon 规则的生效起始日，早于该日期的历史数据不叠加、不重写
        ov_from = serial_of(((topon_by_name or {}).get(name) or {}).get("预估口径起始日"))
        ef_from = serial_of(f.get("生效起始日"))
        if overlay:
            # 叠加产品的 topon 规则已不再写这几列（避免先写单侧值、随后被本规则覆盖），
            # 因此本规则要把「topon 源有、max 源没有」的日期也覆盖到，否则那些天没人写。
            dts = {s for s, _ in keys}
            if ov_plat:
                dts |= {k[2] for k in src["topon"] if k[0] == ov_app and k[1] == ov_plat}
            keys = [(s, src["max"].get((app, s)) or {}) for s in sorted(dts)]
    elif src_type == "admob":
        # admob 与 max 同属「叠加型」来源：收益/展示与 topon 相加，eCPM 按合计重算。
        # 源表按 (App, Type=平台) 定位，平台取规则里的「平台」字段（admob 源里两产品同名，靠 Type 区分）。
        app = txt(f.get("源应用名")) or name
        plat = txt(f.get("平台"))
        keys = [(s, src["admob"].get((app, plat, s))) for s in
                sorted({k[2] for k in src["admob"] if k[0] == app and k[1] == plat})]
        metrics = [(col_to_idx(txt(f.get(c))) - 1, k, k, k) for c, k in
                   [("收益写入列", "收益"), ("展示写入列", "展示"), ("ecpm写入列", "ecpm")] if txt(f.get(c))]
        get_val = lambda d, est_k, api_k: ((d.get(est_k), "API") if d and d.get(est_k) is not None else (None, None))
        overlay = True
        tr = (topon_by_name or {}).get(name) or {}
        ov_app = txt(tr.get("源应用名")) or name
        ov_plat = txt(tr.get("平台"))
        ov_est = bool(tr.get("始终用预估"))
        ov_from = serial_of(tr.get("预估口径起始日"))
        ef_from = serial_of(f.get("生效起始日"))
        # 同 max：把「topon 源有、admob 源没有」的日期也覆盖到（topon 规则已不写这几列）
        dts = {s for s, _ in keys}
        if ov_plat:
            dts |= {k[2] for k in src["topon"] if k[0] == ov_app and k[1] == ov_plat}
        keys = [(s, src["admob"].get((app, plat, s)) or {}) for s in sorted(dts)]
    else:  # consume
        keys = [(s, src["consume"].get((name, s))) for s in
                sorted({k[1] for k in src["consume"] if k[0] == name})]
        metrics = [(col_to_idx(txt(f.get(c))) - 1, k, k, k) for c, k in
                   [("消耗写入列", "消耗"), ("安装写入列", "安装")] if txt(f.get(c))]
        get_val = lambda d, est_k, api_k: ((d.get(est_k), "API") if d and d.get(est_k) is not None else (None, None))

    if selected_dates is not None:
        serials = {date_serial(day) for day in selected_dates}
        keys = [(serial, data) for serial, data in keys if serial in serials]
        available = {serial for serial, data in keys if data is not None
                     and all(data.get(metric) is not None for _column, metric, _api, _label in metrics)}
        missing = [day for day in selected_dates if date_serial(day) not in available]
        if missing:
            result.update(ok=False, err='所选日期缺少消耗源数据：' + '、'.join(missing), missingDates=missing)

    zero_skip = bool(f.get("零值跳过"))
    # 不补缺行：目标表没有该日期时不再追加新行，只写已存在的日期行
    no_new_rows = bool(f.get("不补缺行"))
    # 始终用预估：该产品不做「t-1 预估 / 更早 API 覆盖」，收益与展示一律取源表预估列
    est_always = bool(f.get("始终用预估"))
    # 生效起始日：勾了「始终用预估」时，早于该日期的历史数据保持原样、不重写（留空则不限制）
    est_from = serial_of(f.get("预估口径起始日")) if src_type == "topon" else None
    # 收益列口径：数据日 >= 今天 - 预估优先天数 用预估，更早用 API 覆盖。
    # topon 规则作用于自身收益列；max 规则仅用于「叠加 topon」时对齐 topon 侧口径。
    est_days = 1
    if src_type in ("topon", "max"):
        n = f.get("预估优先天数")
        if isinstance(n, (int, float)):
            est_days = max(0, int(n))
        elif isinstance(n, str) and n.strip().isdigit():
            est_days = max(0, int(n.strip()))
    cutoff = today_serial() - est_days
    result["预估优先天数"] = est_days if src_type == "topon" else None
    result["始终用预估"] = est_always if src_type == "topon" else None
    result["叠加topon"] = overlay
    # 叠加源的「生效起始日」（口径切换日）：之前的历史由同产品 topon 规则维护
    result["生效起始日"] = date_of_serial(ef_from) if ef_from is not None else None
    # 审计用元信息：平台 / 目标文档 / 子表，以及单元格级变更（旧值→新值）
    result["平台"] = txt(f.get("平台"))
    result["doc"] = obj
    result["sheet"] = sid
    changes = []
    writes = []  # (row_idx, col_idx, value)
    for serial, d in keys:
        if d is None:
            continue
        # 生效起始日之前的历史数据保持原样：整行跳过，不做任何写入
        if est_always and est_from is not None and serial < est_from:
            result["跳历史"] = result.get("跳历史", 0) + 1
            continue
        if overlay and ov_from is not None and serial < ov_from:
            result["跳历史"] = result.get("跳历史", 0) + 1
            continue
        # 叠加源自身的「生效起始日」（如 GP-My Exhibition 9/22 起由 MAX 接管）：
        # 早于该日期的历史仍由同产品 topon 规则维护，本规则不写。
        if ef_from is not None and serial < ef_from:
            result["跳历史"] = result.get("跳历史", 0) + 1
            continue
        # topon 规则的互补区间：生效起始日及以后已交给叠加源，本规则只维护之前的历史。
        # 仅 topon 规则受限；max/admob/consume 规则不受影响。
        if src_type == "topon" and hand_off_from is not None and serial >= hand_off_from:
            result["跳交接"] = result.get("跳交接", 0) + 1
            continue
        # 叠加型来源（max / admob）：收益与展示 = topon 侧 + 该产品「全部」叠加源之和，
        # eCPM 按 合计收益 ÷ 合计展示 × 1000 重算。
        # 合计里包含所有叠加源（不只本规则自身），因此与执行顺序无关、可重复执行，
        # 也避免同一产品同时有 max 和 admob 规则时互相覆盖。
        ov_rev = ov_show = None
        if overlay:
            rev_parts, show_parts = [], []
            if ov_plat:
                t = src["topon"].get((ov_app, ov_plat, serial))
                if t:
                    # 收益沿用预估优先口径；展示与 topon 规则一致，按 API 优先。
                    # 若同一产品的 topon 规则勾了「始终用预估」，则收益与展示都取预估列。
                    tv, _ = pick_metric(t, "预估收益", "API收益", True if ov_est else (serial >= cutoff))
                    ts, _ = pick_metric(t, "预估展示", "API展示", ov_est)
                    if tv is not None:
                        rev_parts.append(tv)
                    if ts is not None:
                        show_parts.append(ts)
            for otype, oapp, oplat, _of in (overlay_by_name or {}).get(name, []):
                if otype == "max":
                    od = src["max"].get((oapp, serial))
                elif otype == "admob":
                    od = src["admob"].get((oapp, oplat, serial))
                else:
                    od = None
                if not od:
                    continue
                ov, _kd = get_val(od, "收益", "收益")
                osh, _kd2 = get_val(od, "展示", "展示")
                if ov is not None:
                    rev_parts.append(ov)
                if osh is not None:
                    show_parts.append(osh)
            if rev_parts:
                ov_rev = sum(rev_parts)
            if show_parts:
                ov_show = sum(show_parts)
            if ov_rev is not None:
                result["叠加写"] = result.get("叠加写", 0) + 1
        vals = []
        for ci, ek, ak, label in metrics:
            if overlay and ek in ("收益", "展示", "ecpm"):
                if ek == "收益":
                    v, kd = ov_rev, "API"
                elif ek == "展示":
                    v, kd = ov_show, "API"
                else:  # ecpm：按合计收益/合计展示重算，避免分子分母口径不一致
                    v = (ov_rev / ov_show * 1000) if (ov_rev is not None and ov_show) else None
                    kd = "API"
            elif ek == "请求":
                # 请求不做叠加，只写本来源的请求数
                v, kd = get_val(d, "请求", "请求")
            elif src_type == "topon" and (est_always or ek == "预估收益"):
                v, kd = pick_metric(d, ek, ak, True if est_always else (serial >= cutoff))
            else:
                v, kd = get_val(d, ek, ak)
            if v is not None:
                vals.append((ci, v, kd, label))
        if not vals:
            continue
        if serial not in dmap:
            if no_new_rows:
                # 该规则不补缺行：目标表没有的日期整行跳过，不动表格结构
                result["跳缺行"] = result.get("跳缺行", 0) + 1
                continue
            result["缺行"] += 1
            max_row += 1
            dmap[serial] = max_row
            writes.append((max_row, date_ci, serial, "日期"))
            changes.append({"cell": f"{idx_to_col(date_ci + 1)}{max_row + 1}", "metric": "日期",
                            "old": None, "new": serial, "date": serial})
            while len(rows) <= max_row:
                rows.append([])
        ri = dmap[serial]
        row = rows[ri] if ri < len(rows) else []
        for ci, v, kd, label in vals:
            if v == 0 and zero_skip:
                result["零值"] += 1
                continue
            cur = num(row[ci]) if ci < len(row) else None
            if close(cur, v):
                result["跳过"] += 1
                continue
            writes.append((ri, ci, v, kd))
            # 审计：记录单元格级 旧值 → 新值（回滚依据）
            changes.append({"cell": f"{idx_to_col(ci + 1)}{ri + 1}", "metric": label,
                            "old": cur, "new": v, "date": serial})
    # 应用写入
    if not dry and writes:
        vr = []
        for ri, ci, v, kd in writes:
            col = idx_to_col(ci + 1)
            vr.append({"range": f"{sid}!{col}{ri + 1}:{col}{ri + 1}",
                       "values": [[int(v) if isinstance(v, float) and v == int(v) else v]]})
        applied = []
        for i in range(0, len(vr), 100):
            try:
                reply = run(["api", "POST", f"/open-apis/sheets/v2/spreadsheets/{obj}/values_batch_update",
                             "--data", json.dumps({"valueRanges": vr[i:i + 100]})])
                if not (reply.get("ok") or reply.get("code") == 0 or reply.get("data")):
                    raise RuntimeError('目标表未确认本批次写入成功')
            except Exception as error:
                result.update(ok=False, err=f'产品“{name}”写入失败：{error}；其余产品继续执行。', writeUnconfirmed=True)
                break
            applied.extend(writes[i:i + 100])
            time.sleep(0.2)
        writes = applied
        committed = {f'{idx_to_col(ci + 1)}{ri + 1}' for ri, ci, _value, _kind in writes}
        changes = [change for change in changes if change['cell'] in committed]
        # 写完后同步缓存：同文档/同子表的后续规则应看到最新值，而非写前快照。
        for ri, ci, v, kd in writes:
            while len(rows) <= ri:
                rows.append([])
            row = rows[ri]
            while len(row) <= ci:
                row.append(None)
            row[ci] = v
    for ri, ci, v, kd in writes:
        if kd == "日期":
            continue
        result["写"] += 1
        result[kd] = result.get(kd, 0) + 1
    result["changes"] = changes
    return result


def build_overlay_context(rules):
    """汇总「叠加」相关上下文，供 process_rule 使用。

    返回 (topon_by_name, overlay_by_name, overlay_cols, overlay_starts)：
    - topon_by_name：产品名 -> topon 规则字段，用于 max 规则判断叠加侧口径（始终用预估 / 生效起始日）
    - overlay_by_name：产品名 -> [(类型, 源应用名, 平台, 字段)]，叠加合计 = topon + 该产品全部叠加源
    - overlay_cols：产品名 -> 被叠加规则接管的列下标（这些列 topon 规则不再写，避免中间态）
    - overlay_starts：产品名 -> 口径切换日序列号（仅当该产品全部叠加源都填了「生效起始日」）
    """
    # 供 max 规则的「叠加 topon」判断同产品的 topon 规则口径（如「始终用预估」）
    topon_by_name = {txt(r["fields"].get("产品名")): r["fields"]
                     for r in rules if r["src_type"] == "topon"}
    # 叠加型来源（max / admob）按产品名归集：叠加合计 = topon + 该产品全部叠加源，
    # 与该产品有几条叠加规则、谁先谁后无关（避免 max 与 admob 互相覆盖）。
    # 只统计「启用」的叠加规则：停用后不应再参与合计，也不应继续接管 topon 的列。
    overlay_by_name = defaultdict(list)
    for r in rules:
        st, of = r["src_type"], r["fields"]
        if not of.get("启用"):
            continue
        onm = txt(of.get("产品名"))
        if st == "max":
            # 注意：max 源表是以「完整应用名（可能含 (iOS)/(Android)）」为键，不能拆平台后缀
            overlay_by_name[onm].append((st, txt(of.get("源应用名")) or onm, None, of))
        elif st == "admob":
            overlay_by_name[onm].append(
                (st, txt(of.get("源应用名")) or onm, txt(of.get("平台")), of))
    # 被叠加规则接管的列：这些列上的 topon 规则不再写，交给 max/admob 统一写合计
    overlay_cols = defaultdict(set)
    for onm, peers in overlay_by_name.items():
        for _ot, _oa, _op, of in peers:
            for c in ("收益写入列", "展示写入列", "ecpm写入列"):
                if txt(of.get(c)):
                    overlay_cols[onm].add(col_to_idx(txt(of.get(c))) - 1)
    # 「生效起始日」：叠加源填了该字段就是「某日起才接管」的口径切换（如 GP-My Exhibition
    # 9/22 起由 MAX 聚合接管）。仅当该产品全部叠加源都填了起始日时，才判定为互补区间
    # ——此时 topon 规则只维护起始日之前的历史，不再把列交出去（否则起始日之前无人写）。
    overlay_starts = {}
    for onm, peers in overlay_by_name.items():
        starts = [serial_of(of.get("生效起始日")) for _ot, _oa, _op, of in peers]
        if starts and all(s is not None for s in starts):
            overlay_starts[onm] = min(starts)
    return topon_by_name, overlay_by_name, overlay_cols, overlay_starts


def main():
    dates = parse_dates()
    dry = "--dry" in sys.argv
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    only_type = None
    if "--type" in sys.argv:
        only_type = sys.argv[sys.argv.index("--type") + 1]
    if dates and only_type != 'consume':
        raise ValueError('--dates 日期选择仅适用于 --type consume。')
    try:
        rules_all = json.load(open("rules_full.json"))
    except FileNotFoundError:
        sys.exit(
            "缺少规则快照 rules_full.json。\n"
            "首次运行请用 python3 run_consume.py（第 1 步会自动重建快照），"
            '或先执行 python3 -c "import run_consume; run_consume.snapshot_consume()"'
        )
    rules = []
    for st in ("topon", "max", "admob", "consume"):
        for r in rules_all.get(st, []):
            r["src_type"] = st
            rules.append(r)
    enabled = [r for r in rules if r["fields"].get("启用")]
    if only_type:
        enabled = [r for r in enabled if r["src_type"] == only_type]
    if only:
        enabled = [r for r in enabled if only in txt(r["fields"].get("产品名"))]
    print(f"启用规则 {len(enabled)} 条 (dry={dry})")

    # 只加载本轮真正需要的源表：以前无论跑哪种类型都会把 4 张源表（每张 6 万行）全读一遍，
    # 消耗同步因此白等 topon/max/admob 两次大范围读取。叠加（max/admob）需要 topon 源。
    _need = {r["src_type"] for r in enabled if r.get("src_type")}
    if _need & {"max", "admob"}:
        _need.add("topon")
    source_started = time.monotonic()
    print("开始读取本轮来源数据...", flush=True)
    src = load_sources([r for r in rules if r.get("src_type") in (_need or {r.get("src_type") for r in rules})])
    print(f"源数据: topon {len(src['topon'])} max {len(src['max'])} consume {len(src['consume'])}（读取用时 {time.monotonic() - source_started:.1f}s）")

    obj_cache, sheet_cache = {}, {}
    topon_by_name, overlay_by_name, overlay_cols, overlay_starts = build_overlay_context(rules)
    # 并行预读本轮所有目标表（每张 lark-cli 读取都是独立子进程，串行读 90+ 张是主要耗时）。
    # 预读只填充缓存，不写任何数据；process_rule 随后直接命中缓存。
    prewarm_targets(enabled, obj_cache, sheet_cache)
    rules_started = time.monotonic()
    results = []
    for i, rec in enumerate(enabled):
        try:
            res = process_rule(rec, src, obj_cache, sheet_cache, dry, topon_by_name, overlay_by_name,
                               overlay_cols, overlay_starts, dates)
        except Exception as error:
            fields = rec.get('fields', {})
            res = {'record_id': rec['record_id'], 'src_type': rec['src_type'], 'name': txt(fields.get('产品名')),
                   '平台': txt(fields.get('平台')), 'ok': False, 'err': str(error),
                   '写': 0, '跳过': 0, '零值': 0, '缺行': 0, '预估': 0, 'API': 0, 'changes': []}
        if dates is not None:
            res['dates'] = dates
        results.append(res)
        mark = "✓" if res["ok"] else "✗"
        print(f"进度 {i + 1}/{len(enabled)}：已处理 {res['name']}")
        time.sleep(0.15)

    print(f"规则处理完成，用时 {time.monotonic() - rules_started:.1f}s", flush=True)
    out_name = f"full_review_result_{only_type}.json" if only_type else "full_review_result.json"
    json.dump(results, open(out_name, "w"), ensure_ascii=False, indent=1)
    ok = sum(1 for r in results if r["ok"])
    print(f"\n合计: 成功 {ok}/{len(results)}, 写入 {sum(r['写'] for r in results)} 格, "
          f"跳过 {sum(r['跳过'] for r in results)}, 缺行补日期 {sum(r['缺行'] for r in results)}")

    for row in results:
        if not row['ok']:
            print(f"  未完成：{row['name']} — {row['err']}")
    if dry:
        return
    # Persist actual acknowledged changes before remote status updates.
    own_run = not sync_log.current_run_id()
    if own_run:
        sync_log.new_run(trigger="full_review", argv=" ".join(sys.argv), mode="partial")
    n_rules, n_cells = sync_log.log_rule_results(results)
    # 回写状态到三张规则表
    now_ms = int(time.time() * 1000)
    by_table = defaultdict(list)
    for r in results:
        f = r
        if r["src_type"] == "consume":
            desc = f"写入 {r['写']} 格；已一致跳过 {r['跳过']}；零值跳过 {r['零值']}；目标缺日期行 {r['缺行']}"
        else:
            desc = f"写 {r['写']} 格（预估口径 {r.get('预估',0)}/API口径 {r.get('API',0)}），已一致跳过 {r['跳过']}，零值日 {r['零值']}，目标缺日期行 {r['缺行']}"
            if r.get("叠加topon"):
                desc += f"；收益/展示已叠加 topon（叠加 {r.get('叠加写', 0)} 格）"
            elif r["src_type"] == "topon":
                if r.get("交给叠加"):
                    desc += f"；{'/'.join(r['交给叠加'])} 列由叠加规则(max/admob)统一写合计"
                if r.get("始终用预估"):
                    desc += "；口径 始终用预估（收益/展示不做 API 覆盖）"
                elif not r.get("交给叠加"):
                    desc += f"；收益列口径 预估优先 {r.get('预估优先天数') or 1} 天"
        if r.get("跳缺行"):
            desc += f"；不补缺行，已跳过 {r['跳缺行']} 个目标表不存在的日期"
        if r.get("跳历史"):
            desc += f"；生效起始日前 {r['跳历史']} 天已跳过（历史数据未改动）"
        if r.get("跳交接"):
            desc += f"；生效起始日之后 {r['跳交接']} 天已交由叠加规则(max/admob)接管"
        if r["src_type"] in ("max", "admob") and r.get("生效起始日"):
            desc += f"；生效起始日 {r['生效起始日']}（之前历史由 topon 规则维护）"
        fields = {"最近运行时间": now_ms, "最近运行状态": "成功" if r["ok"] else "失败",
                  "状态说明": (desc if r["ok"] else f"{desc}；错误: {r['err']}")}
        if r["src_type"] == "topon":
            fields["手动触发"] = False
        by_table[TABLES[r["src_type"]]].append({"record_id": r["record_id"], "fields": fields})
    status_started = time.monotonic()
    print(f"开始回写 {sum(len(rows) for rows in by_table.values())} 条规则状态...", flush=True)
    status_ok = True
    names = {row['record_id']: row['name'] for row in results}
    for (base, tid), recs in by_table.items():
        try:
            update_records(base, tid, recs)
        except Exception as error:
            status_ok = False
            failures = getattr(error, 'failures', [{'record_id': tid, 'error': str(error)}])
            for failure in failures:
                product = names.get(failure['record_id'], '规则状态回写')
                sync_log.log_step('status:' + failure['record_id'], ok=False, summary=f"{product}：{failure['error']}")
            print(f'规则状态回写已结束，{len(failures)} 条未完成；业务同步结果已保存在本地。')
    print(f"规则状态回写完成，用时 {time.monotonic() - status_started:.1f}s", flush=True)
    if own_run:
        sync_log.finish_run(ok=status_ok and all(row['ok'] for row in results), note='全部规则处理结束，逐项结果与已确认变更已保存')
    print(f"审计日志: run={sync_log.current_run_id()} 规则 {n_rules} 条, 单元格变更 {n_cells} 格")


if __name__ == "__main__":
    main()
