#!/usr/bin/env python3
"""每日大盘与异动监控汇总：把各产品目标表最新数据汇总到大盘表。
数据流：目标表(收益/展示/消耗) -> 每日大盘与异动监控表(tblidqds37MNgYwC)
用法: python3 dapan_sync.py [--dry]
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
from pathlib import Path

from codex_lark_adapter import list_records, update_records
import sync_log
from sync_dates import date_serial, parse_dates

from codex_lark_adapter import cli_command, cli_error
BASE = "Nmc8b6FAxa62VZsQwIfck1Bcn9f"
TABLE_DAPAN = "tblidqds37MNgYwC"
# 规则明细统一来自 rules_full.json（由 run_all.py 刷新）；广告规则已迁至独立 base
# 「广告同步规则」，此处只按类型遍历，不再需要具体表 ID。
RULE_TYPES = ("topon", "max", "admob", "consume")

# 诊断阈值（由 9.2 现有数据反推）
REV_MIN = 20.0      # 前日收益门槛
CHG_MIN = 0.30      # 环比波动门槛

# 审计：只记这些大盘字段的变更（更新时间之类的噪声不记）
DAPAN_WATCH = ("数据日", "广告收益", "买量消耗", "当日展示数", "当日ROI", "前日收益",
               "前日消耗", "消耗日环比")


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
    # sheets/query 偶发返回错误/空（限流或瞬时故障）：失败重试，且不缓存空结果，
    # 否则会把空表列表写进缓存，整轮都报「目标子表未找到」。
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


def search_all(table_id, field_names):
    return list_records(BASE, table_id, field_names)


def load_rules():
    """返回 {(产品名, 平台): {收益列, 展示列, 目标URL, 目标子表, 目标日期列}}（仅收益规则）"""
    mapping = defaultdict(dict)
    try:
        all_rules = json.load(open("rules_full.json"))
    except FileNotFoundError:
        all_rules = {}
    for st in RULE_TYPES:
        if st == "consume":
            continue
        for r in all_rules.get(st, []):
            f = r.get("fields", {})
            if not f.get("启用"):
                continue
            name = txt(f.get("产品名"))
            plat = str(f.get("平台"))
            key = (name, plat)
            m = mapping[key]
            m["目标URL"] = txt(f.get("目标表URL"))
            m["目标子表"] = txt(f.get("目标子表匹配"))
            m["目标日期列"] = txt(f.get("目标日期列")) or "A"
            if txt(f.get("收益写入列")):
                m["收益列"] = txt(f.get("收益写入列"))
            if txt(f.get("展示写入列")):
                m["展示列"] = txt(f.get("展示写入列"))
    return mapping


def norm_name(name):
    """产品名归一化：去平台前后缀、中文标注、非字母数字字符，用于跨表匹配。"""
    s = name.lower()
    s = re.sub(r"^(gp|ios)[\-_\s]", "", s)
    s = re.sub(r"[\-_ ](ios|gp|and|android).*$", "", s)
    s = re.sub(r"(连连看|倒水|毛线|拼图|汉堡|企鹅|树\d*消|果汁三消).*$", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def doc_key(url):
    """提取文档 token（wiki/sheets），忽略 query 参数，用于判定两条规则是否指向同一张产品表。"""
    m = re.search(r"/(?:wiki|sheets)/([A-Za-z0-9]+)", url or "")
    return m.group(1) if m else None


def infer_plat(name):
    """从消耗规则产品名推断平台：And/gp → Android，ios → iOS，无标记 → None。"""
    s = name.lower()
    if re.search(r"[\-_ ]and(roid)?$", s) or re.match(r"^gp[\-_\s]", s) or re.search(r"[\-_ ]gp$", s):
        return "Android"
    if re.match(r"^ios[\-_\s]", s) or re.search(r"[\-_ ]ios", s):
        return "iOS"
    return None


def load_consume_rules():
    """返回消耗规则列表: [{norm, plat, cost_col, url, sub, date_col, name}]"""
    try:
        all_rules = json.load(open("rules_full.json"))
    except FileNotFoundError:
        return []
    out = []
    for r in all_rules.get("consume", []):
        f = r.get("fields", {})
        if not f.get("启用"):
            continue
        name = txt(f.get("产品名"))
        cost_col = txt(f.get("消耗写入列"))
        url = txt(f.get("目标表URL"))
        if not (name and cost_col and url):
            continue
        out.append({
            "norm": norm_name(name),
            # 平台：优先用规则表里手工维护的「平台」字段，其次按产品名标记推断
            "plat": txt(f.get("平台")) or infer_plat(name),
            "cost_col": cost_col,
            "url": url,
            "key": doc_key(url),
            "sub": txt(f.get("目标子表匹配")),
            "date_col": txt(f.get("目标日期列")) or "A",
            "name": name,
        })
    return out


def match_consume(consume_rules, rev_name, rev_plat, rev_url=None):
    """为大盘行 (产品名, 平台) 匹配消耗规则。
    优先按目标文档 token 精确匹配（最可靠，避免同名/归一化歧义）；
    再退化为 归一化名+平台；最后做前缀兜底。
    """
    # 1. 目标文档相同即为同一产品表，直接命中
    rk = doc_key(rev_url)
    if rk:
        same = [c for c in consume_rules if c.get("key") == rk]
        if same:
            exact_plat = [c for c in same if c["plat"] == rev_plat]
            if exact_plat:
                return exact_plat[0]
            # 该消耗表已明确归属其它平台（同一张消耗表被 Android/iOS 两行共用）：
            # 不再回退，返回「平台不符」标记，避免同一份消耗被两行各算一次
            if all(c["plat"] for c in same):
                return {"plat_mismatch": True, "plat": same[0]["plat"], "name": same[0]["name"]}
            return same[0]
    n = norm_name(rev_name)
    if not n:
        return None
    same_norm = [c for c in consume_rules if c["norm"] == n]
    exact = [c for c in same_norm if c["plat"] is None or c["plat"] == rev_plat]
    if exact:
        return exact[0]
    # 同名规则存在、但全部明确归属其它平台 -> 该产品的消耗归另一平台，本行不承担
    if same_norm and all(c["plat"] for c in same_norm):
        return {"plat_mismatch": True, "plat": same_norm[0]["plat"], "name": same_norm[0]["name"]}
    # 前缀兜底：一方归一化名是另一方前缀（>=6字符），取最长候选，平台需一致或无标记
    cands = []
    for c in consume_rules:
        if c["plat"] is not None and c["plat"] != rev_plat:
            continue
        a, b = c["norm"], n
        if not a or a == b:
            continue
        short, long = (a, b) if len(a) < len(b) else (b, a)
        if len(short) >= 6 and long.startswith(short):
            cands.append(c)
    if cands:
        return max(cands, key=lambda c: len(c["norm"]))
    return None


ROWS_CACHE = {}


def sheet_rows(obj, sid):
    """带缓存读取整个子表，避免同一文档重复拉取。"""
    key = (obj, sid)
    if key not in ROWS_CACHE:
        ROWS_CACHE[key] = get_values(obj, f"{sid}!A1:CZ800")
    return ROWS_CACHE[key]


def prewarm(pairs, obj_cache, sheet_cache, workers=12):
    """并行预读本轮到要用的目标表（广告文档 + 消耗文档）。

    引擎每次读写都要起一个 lark-cli 子进程，串行跑 150+ 张表会拖到二十分钟以上；
    这里把「解析文档/子表 + 拉取整表」全部并发，主循环随后只命中缓存，几乎不再等网络。
    """
    todo = sorted({p for p in pairs if p and p[0]})

    def work(pair):
        url, hint = pair
        try:
            obj = resolve_obj(url, obj_cache)
            if not obj:
                return
            sid = pick_sheet(obj, hint, sheet_cache)
            if not sid:
                return
            if (obj, sid) not in ROWS_CACHE:
                ROWS_CACHE[(obj, sid)] = get_values(obj, f"{sid}!A1:CZ800")
        except Exception:
            pass

    print(f"   并行预读 {len(todo)} 张目标表（{workers} 线程）...")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for count, _ in enumerate(ex.map(work, todo), 1):
            if count % 20 == 0 or count == len(todo):
                print(f"   预读进度: {count}/{len(todo)}", flush=True)
    print(f"   预读完成，用时 {time.time() - t0:.0f}s，命中缓存 {len(ROWS_CACHE)} 张")


def read_target_metric(obj, sid, date_ci, metric_col, date_serial):
    """读目标表某日期行的某指标列的值。metric_col 为列字母或 None。

    同一日期出现多行时取「最后一行」——必须与 full_review.py 的 target_date_rows
    （`m[serial] = ri`，后者覆盖前者）保持一致，否则会出现「同步写一行、大盘读另一行」。
    """
    if not metric_col:
        return None
    ci = col_to_idx(metric_col) - 1
    val, hit = None, False
    for row in sheet_rows(obj, sid):
        if not row:
            continue
        a = row[date_ci] if date_ci < len(row) else None
        if isinstance(a, (int, float)) and int(a) == date_serial:
            val = num(row[ci]) if ci < len(row) else None
            hit = True
    return val if hit else None


def read_target_day(obj, sid, date_ci, cols, date_serial):
    """读目标表某日期行的多列值。cols: {指标名: 列字母}

    同一日期出现多行时取「最后一行」，口径同上。
    """
    ci_map = {k: col_to_idx(c) - 1 for k, c in cols.items() if c}
    out, hit = {}, False
    for row in sheet_rows(obj, sid):
        if not row:
            continue
        a = row[date_ci] if date_ci < len(row) else None
        if isinstance(a, (int, float)) and int(a) == date_serial:
            out = {k: (num(row[ci]) if ci < len(row) else None) for k, ci in ci_map.items()}
            hit = True
    return out if hit else {}


def dup_date_rows(obj, sid, date_ci):
    """返回该目标表里出现多次的日期序列号列表（重复日期行会导致取行歧义）。"""
    cnt = defaultdict(int)
    for row in sheet_rows(obj, sid):
        if not row:
            continue
        a = row[date_ci] if date_ci < len(row) else None
        if isinstance(a, (int, float)) and 45000 < a < 47000:
            cnt[int(a)] += 1
    return sorted(s for s, n in cnt.items() if n > 1)


def diagnose(prev_rev, rev, chg):
    if prev_rev is not None and prev_rev > REV_MIN:
        if chg is not None and chg < -CHG_MIN:
            return "🚨严重腰斩", f"收益跌幅 {chg * 100:+.1f}% (${prev_rev:,.1f} → ${rev:,.1f})"
        if chg is not None and chg > CHG_MIN:
            return "🚀暴涨突破", f"收益增幅 {chg * 100:+.1f}% (${prev_rev:,.1f} → ${rev:,.1f})"
    return "🟢正常平稳", "大盘指标正常，波动在合理区间"


def chg_rate(cur, prev):
    if cur is None or prev is None:
        return None
    if prev == 0:
        return 1.0 if cur > 0 else (-1.0 if cur < 0 else 0.0)
    return (cur - prev) / prev


def main():
    dates = parse_dates()
    dry = "--dry" in sys.argv
    report_path = Path(__file__).resolve().parent / "dapan-result.json"
    if report_path.exists():
        report_path.unlink()
    parent_run_id = sync_log.current_run_id()
    mapping = load_rules()
    consume_rules = load_consume_rules()
    print(f"规则映射: {len(mapping)} 个 (产品名,平台); 消耗规则: {len(consume_rules)} 条")
    # 广告规则映射是匹配大盘行的唯一依据：为空时必须显式失败，
    # 否则会出现「75 行全跳过、大盘没更新，却照样把过期卡片推出去」的情况。
    if not mapping:
        print("!! 广告规则映射为空（rules_full.json 缺少 topon/max/admob 段），无法匹配大盘行。")
        print("   请先重建完整快照：python3 -c \"import run_all; run_all.refresh_rules()\"")
        print("   已中止本轮大盘刷新。")
        sys.exit(2)
    run_id = sync_log.new_run(trigger="auto", argv=" ".join([sys.executable] + sys.argv), mode="dapan")
    print(f"### 大盘运行编号 {run_id}")

    dapan_records = search_all(TABLE_DAPAN, ["产品名", "平台", "目标表链接"])
    print(f"大盘表现有记录: {len(dapan_records)} 条")

    dup_warn = []  # 目标表里存在重复日期行的产品（同步与大读取行会有歧义）
    skip_unresolved = []  # 目标文档/子表解析失败而被跳过的产品（不再静默跳过）
    plat_skips = []  # 按平台归属跳过消耗的行（同一张消耗表被两个平台行共用，避免重复计入）
    dapan_log = []  # 审计：大盘字段级变更（旧值 → 新值）

    # Explicit consumption updates summarize the last selected day; legacy runs use the source's latest day.
    if dates:
        today_serial = date_serial(dates[-1])
    else:
        src_obj = resolve_obj("https://iwfeys1lhifi.feishu.cn/wiki/C59YwLnEmiLTfbkOCjScIf7rnQe", {})
        src_rows = get_values(src_obj, "0uKWKA!A2:A60000")
        max_serial = max((int(r[0]) for r in src_rows if r and isinstance(r[0], (int, float)) and 45000 < r[0] < 47000), default=None)
        if max_serial is None:
            print("无法确定最新日期，退出")
            return
        today_serial = max_serial
    prev_serial = today_serial - 1
    today_day = date(1899, 12, 30) + timedelta(days=today_serial)
    today_ms = int(datetime(today_day.year, today_day.month, today_day.day).timestamp() * 1000)
    print(f"大盘数据日: {today_day} (serial {today_serial}), 前一日 serial {prev_serial}")

    obj_cache, sheet_cache = {}, {}

    # 并行预读：把本轮要用的广告文档 + 消耗文档一次性并发拉进缓存，
    # 主循环不再串行等网络（这是大盘从 20 分钟降到几分钟的关键）。
    _pairs = [(r["目标URL"], r.get("目标子表")) for r in mapping.values() if r.get("目标URL")]
    _pairs += [(c["url"], c.get("sub")) for c in consume_rules if c.get("url")]
    prewarm(_pairs, obj_cache, sheet_cache)

    updates = []
    report_records = []
    skipped_no_rule = []
    cost_hit = cost_miss = 0
    missed_cost_names = []
    failed_consume = set(json.loads(os.environ.get('SYNC_FAILED_CONSUME_PRODUCTS', '[]')))
    for rec in dapan_records:
        try:
            f = rec["fields"]
            name = txt(f.get("产品名"))
            plat = str(f.get("平台"))
            key = (name, plat)
            rule = mapping.get(key)
            cost_only = False
            if not rule:
                # 没有广告规则的大盘行：只要消耗规则能匹配上，仍然更新消耗相关字段
                # （收益/展示没有来源，按 0 处理）。用于只跟消耗、未接广告的产品。
                # 若匹配结论是「该消耗归属另一个平台」，后面的平台不符分支会把本行写 0。
                probe = match_consume(consume_rules, name, plat, None)
                if probe:
                    rule, cost_only = {}, True
                else:
                    skipped_no_rule.append((name, plat))
                    continue
            url = rule.get("目标URL")
            consume_match = match_consume(consume_rules, name, plat, url)
            if consume_match and consume_match.get('name') in failed_consume and not consume_match.get('plat_mismatch'):
                skip_unresolved.append((name, plat, '本轮消耗同步未完成，保留原大盘记录，避免将旧消耗当作本轮结果'))
                continue
            if cost_only:
                # 无广告规则：收益/展示无来源，按 0 处理，只更新消耗相关字段
                rev = prev_rev = imp = prev_imp = None
            else:
                if not url:
                    skip_unresolved.append((name, plat, "规则未填目标表URL"))
                    continue
                obj = resolve_obj(url, obj_cache)
                if not obj:
                    skip_unresolved.append((name, plat, "目标文档无法解析（可能是临时失败，下一轮会重试）"))
                    continue
                sid = pick_sheet(obj, rule.get("目标子表"), sheet_cache)
                if not sid:
                    skip_unresolved.append((name, plat, "目标子表未找到"))
                    continue
                date_ci = col_to_idx(rule["目标日期列"]) - 1
                dups = dup_date_rows(obj, sid, date_ci)
                if dups:
                    dup_warn.append((name, plat, len(dups), dups[-1]))
                cols = {k: rule[k] for k in ("收益列", "展示列") if rule.get(k)}
                today = read_target_day(obj, sid, date_ci, cols, today_serial)
                prev = read_target_day(obj, sid, date_ci, cols, prev_serial)

                rev = today.get("收益列")
                prev_rev = prev.get("收益列")
                imp = today.get("展示列")
                prev_imp = prev.get("展示列")

            # 消耗：独立匹配消耗规则（产品名归一化+平台），从对应目标表读消耗列
            cost = None
            prev_cost = None
            plat_skip = None
            crule = match_consume(consume_rules, name, plat, url)
            if crule and crule.get("plat_mismatch"):
                # 这份消耗归属另一个平台（两个平台行共用同一张消耗表）：
                # 本行不承担消耗 —— 消耗与前日都写 0，避免总消耗重复计入，也不触发停投/倒挂预警
                plat_skip = crule.get("plat")
                plat_skips.append((name, plat, plat_skip))
                cost, prev_cost = 0.0, 0.0
                crule = None
            if crule:
                cobj = resolve_obj(crule["url"], obj_cache)
                if cobj:
                    csid = pick_sheet(cobj, crule.get("sub"), sheet_cache)
                    if csid:
                        cdate_ci = col_to_idx(crule["date_col"]) - 1
                        if sheet_rows(cobj, csid):
                            # 目标表可读：命中日期则取消耗值；该日期为空按 0 处理
                            # （消耗规则多勾了「零值跳过」，0 消耗当天不写入，读到的就是空）
                            cost = read_target_metric(cobj, csid, cdate_ci, crule["cost_col"], today_serial)
                            if cost is None:
                                cost = 0.0
                            # 前日消耗：供消耗日报算日环比、识别停投
                            prev_cost = read_target_metric(cobj, csid, cdate_ci, crule["cost_col"], prev_serial)
                            if prev_cost is None:
                                prev_cost = 0.0
            if plat_skip:
                cost_hit += 1  # 已按平台归属处理：这份消耗算在另一平台行上
            elif crule and cost is not None:
                cost_hit += 1
            else:
                cost_miss += 1
                missed_cost_names.append((name, plat, crule["name"] if crule else None))

            chg = chg_rate(rev, prev_rev)
            ecpm = (rev / imp * 1000) if (rev is not None and imp) else None
            prev_ecpm = (prev_rev / prev_imp * 1000) if (prev_rev is not None and prev_imp) else None
            ecpm_chg = chg_rate(ecpm, prev_ecpm)
            diag, diag_desc = diagnose(prev_rev, rev, chg)
            # 无消耗（读不到或为 0）时不计算 ROI：写 0，绝不留用上一天的旧值
            roi = (rev / cost) if (rev is not None and cost) else 0.0

            fields = {
                "数据日": today_ms,
                "广告收益": rev if rev is not None else 0,
                "当日展示数": imp if imp is not None else 0,
                "前日收益": prev_rev if prev_rev is not None else 0,
                "收益日环比": chg if chg is not None else 0,
                "当日eCPM": ecpm if ecpm is not None else 0,
                "eCPM日环比": ecpm_chg if ecpm_chg is not None else 0,
                "波动诊断": diag,
                "异动诊断说明": diag_desc,
                "更新时间": int(time.time() * 1000),
            }
            # 消耗读不到时保留上次可读值（多为无权限文档）；读到则写当前值（含 0）
            if cost is not None:
                fields["买量消耗"] = cost
                # 前日消耗 / 消耗日环比：供「消耗日报」卡片使用（广告卡片不用这两列）
                fields["前日消耗"] = prev_cost if prev_cost is not None else 0
                cchg = chg_rate(cost, prev_cost)
                fields["消耗日环比"] = cchg if cchg is not None else 0
            fields["当日ROI"] = round(roi, 4)
            # 审计：记录大盘关键字段的 旧值 → 新值
            for k in DAPAN_WATCH:
                if k not in fields:
                    continue
                old, new = f.get(k), fields[k]
                if isinstance(old, (int, float)) and isinstance(new, (int, float)):
                    if abs(old - new) <= 1e-9:
                        continue
                elif old == new:
                    continue
                dapan_log.append({"product": name, "platform": plat, "field": k, "old": old, "new": new})
            updates.append({"record_id": rec["record_id"], "fields": fields})
            report_records.append({"record_id": rec["record_id"],
                                   "fields": {"产品名": name, "平台": plat, **fields,
                                              "数据日": today_day.isoformat()}})
        except Exception as error:
            fields = rec.get('fields', {})
            skip_unresolved.append((txt(fields.get('产品名')), str(fields.get('平台')), str(error)))

    print(f"待更新记录: {len(updates)}, 无规则匹配: {len(skipped_no_rule)}")
    print(f"消耗数据: 命中 {cost_hit}, 缺失 {cost_miss}")
    if dup_warn:
        print(f"⚠ 目标表存在重复日期行: {len(dup_warn)} 个产品（取行口径已统一为「最后一行」，建议清理重复区块）")
        for n, p, cnt, last in dup_warn:
            last_d = (date(1899, 12, 30) + timedelta(days=last)).isoformat()
            print(f"   重复日期行: {n} {p} — 重复 {cnt} 天，最近 {last_d}")
    if skip_unresolved:
        print(f"⚠ 目标表无法定位、本轮跳过: {len(skip_unresolved)} 个产品")
        for n, p, why in skip_unresolved:
            print(f"   跳过: {n} {p} — {why}")
    if plat_skips:
        print(f"  按平台跳过消耗: {len(plat_skips)} 行（同一份消耗已归属另一平台，不重复计入总消耗）")
        for n, p, op in plat_skips:
            print(f"   平台跳过: {n} {p}（消耗归属 {op}）")
    for n, p in skipped_no_rule:
        print(f"  跳过(规则停用/缺失): {n} {p}")
    for n, p, cn in missed_cost_names:
        print(f"  消耗缺失: {n} {p} (匹配到消耗规则: {cn or '无'})")

    for name, platform, error in skip_unresolved:
        sync_log.log_step(f'dapan:item:{name}:{platform}', ok=False, summary=f'{name}（{platform}）：{error}')
    if dry:
        for u in updates[:5]:
            print("DRY", u["fields"])
        return

    write_started = time.monotonic()
    print(f"开始回写 {len(updates)} 条大盘记录...", flush=True)
    completed_ids = {row['record_id'] for row in updates}
    try:
        update_records(BASE, TABLE_DAPAN, updates)
    except Exception as error:
        completed_ids = set(getattr(error, 'completed_ids', []))
        by_id = {row['record_id']: row['fields'] for row in dapan_records}
        failures = getattr(error, 'failures', [{'record_id': 'unknown', 'error': str(error)}])
        for failure in failures:
            fields = by_id.get(failure['record_id'], {})
            product = txt(fields.get('产品名')) or '大盘记录'
            sync_log.log_step('dapan:write:' + failure['record_id'], ok=False, summary=f"{product}：{failure['error']}")
    ok, fail = len(completed_ids), len(updates) - len(completed_ids)
    confirmed_keys = {(txt(row['fields'].get('产品名')), str(row['fields'].get('平台'))) for row in dapan_records if row['record_id'] in completed_ids}
    dapan_log = [row for row in dapan_log if (row['product'], row['platform']) in confirmed_keys]
    print(f"大盘表更新完成: 成功 {ok}, 失败 {fail}（回写用时 {time.monotonic() - write_started:.1f}s）")
    # 审计：回填本次运行的数据日 + 落库大盘字段变更
    sync_log.set_data_day(today_day.isoformat(), run_id=run_id)
    n = sync_log.log_dapan_changes(dapan_log, run_id=run_id)
    print(f"审计日志: run={run_id} 大盘字段变更 {n} 处")
    if ok == 0 and not dry:
        sync_log.finish_run(run_id, ok=False,
                           note=f"大盘 0 行更新（无规则匹配 {len(skipped_no_rule)} 行），视为失败")
        print("!! 本轮大盘 0 行更新：以失败退出，避免后续推送过期卡片")
        sys.exit(3)
    # Keep the exact acknowledged values, including unchanged fields, for this run's daily report.
    # Missing consumption fields are deliberately absent; the report excludes those records.
    report_data = {"schemaVersion": 1, "runId": parent_run_id or run_id,
                   "dashboardRunId": run_id,
                   "generatedAt": datetime.now().astimezone().isoformat(),
                   "dataDate": today_day.isoformat(), "total": len(dapan_records),
                   "records": [row for row in report_records if row["record_id"] in completed_ids]}
    temporary = report_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report_data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, report_path)
    sync_log.finish_run(run_id, ok=(fail == 0 and not skip_unresolved), note=f"大盘数据日 {today_day}（更新 {ok} 行，未完成 {fail + len(skip_unresolved)} 行）")


if __name__ == "__main__":
    main()
