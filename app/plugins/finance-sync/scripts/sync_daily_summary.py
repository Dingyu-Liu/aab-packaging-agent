#!/usr/bin/env python3
"""只读表格并生成本地日报，供 Agent 展示和复制，不发送飞书消息。
用法：python3 sync_daily_summary.py [local] [--consume]
"""
import argparse
import json
import math
import os
from datetime import datetime
from pathlib import Path

import sync_log
from sync_dates import normalize_dates
from codex_lark_adapter import list_records

BASE = "Nmc8b6FAxa62VZsQwIfck1Bcn9f"
TABLE_DAPAN = "tblidqds37MNgYwC"
TABLE_SNAPSHOT = "tbli1YsaHE5uaeiH"
WARN_REV_MIN = 100.0
WARN_CHG_MIN = 0.25
COST_MIN = 100.0
COST_CHG_MIN = 0.25

def search_records(table_id, field_names, base=None):
    return [r.get("fields", {}) for r in list_records(base or BASE, table_id, field_names)]


def first(val):
    if isinstance(val, list) and val:
        v = val[0]
        return v.get("text") if isinstance(v, dict) else v
    return val


def num(val):
    return val if isinstance(val, (int, float)) else 0


def analyze_dapan():
    rows = search_records(TABLE_DAPAN,
                          ["产品名", "广告收益", "前日收益", "当日展示数", "收益日环比",
                           "数据日", "平台", "买量消耗"])
    days = {}
    for r in rows:
        v = r.get("数据日")
        if isinstance(v, (int, float)):
            d = datetime.fromtimestamp(v / 1000).strftime("%Y-%m-%d")
        else:
            d = str(v or "")[:10]
        if d:
            days.setdefault(d, []).append(r)
    latest = max(days)
    rs = days[latest]
    rev = sum(num(r.get("广告收益")) for r in rs)
    prev = sum(num(r.get("前日收益")) for r in rs)
    imp = sum(num(r.get("当日展示数")) for r in rs)
    top = sorted(rs, key=lambda r: -num(r.get("广告收益")))[:3]
    warn = [r for r in rs if num(r.get("广告收益")) > WARN_REV_MIN
            and abs(num(r.get("收益日环比"))) > WARN_CHG_MIN]
    warn.sort(key=lambda r: num(r.get("收益日环比")))
    # 消耗与 ROI：只统计有消耗数据的产品，口径一致，避免用无消耗产品抬高 ROI
    cost_rs = [r for r in rs if num(r.get("买量消耗")) > 0]
    cost_total = sum(num(r.get("买量消耗")) for r in cost_rs)
    rev_cost = sum(num(r.get("广告收益")) for r in cost_rs)
    roi = (rev_cost / cost_total) if cost_total else None
    worst = []
    for r in cost_rs:
        c = num(r.get("买量消耗"))
        v = num(r.get("广告收益"))
        if c < COST_MIN:
            continue
        # 当天展示量为 0 说明广告数据未就绪（源表尚未发布）或当天未投放，
        # 此时收益为 0 不代表真实零收入，不能算作 ROI 倒挂
        if num(r.get("当日展示数")) <= 0:
            continue
        worst.append((str(first(r.get("产品名"))), c, v, v / c))
    worst.sort(key=lambda t: t[3])
    worst = [x for x in worst if x[3] < 1][:3]
    return {
        "date": latest, "products": len(rs), "rev": rev, "prev": prev,
        "chg": (rev / prev - 1) if prev else 0,
        "imp": imp, "ecpm": rev / imp * 1000 if imp else 0,
        "top": [(str(first(r.get("产品名"))), num(r.get("广告收益")),
                 num(r.get("收益日环比"))) for r in top],
        "warn": [(str(first(r.get("产品名"))), num(r.get("前日收益")),
                  num(r.get("广告收益")), num(r.get("收益日环比"))) for r in warn],
        "cost": cost_total, "rev_cost": rev_cost, "roi": roi,
        "cost_hit": len(cost_rs), "cost_all": len(rs), "roi_worst": worst,
    }


def trend():
    rows = search_records(TABLE_SNAPSHOT, ["日期", "总收益"])
    pts = []
    for r in rows:
        v = r.get("日期")
        ts = v if isinstance(v, (int, float)) else None
        if ts:
            day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
            pts.append((day, num(r.get("总收益"))))
    return sorted(pts)[-3:]


def pct(x):
    return f"{'↓' if x < 0 else '↑'} {abs(x) * 100:.1f}%" if x else "— 0.0%"


def money(x):
    return f"${x:,.2f}"


def build_card(d, tr, health, health_bad):
    day_label = f"{int(d['date'][5:7])}月{int(d['date'][8:10])}日"
    roi_txt = f"{d['roi']:.2f}" if d.get("roi") is not None else "—"
    els = [{"tag": "markdown", "content":
            f"**{d['date'][5:7].lstrip('0')}.{d['date'][8:10].lstrip('0')} 单日总览**\n"
            f"💰 收益: **{money(d['rev'])}**（{pct(d['chg'])}）\n"
            f"📈 ROI: **{roi_txt}**"},
           {"tag": "hr"}]
    if len(tr) >= 2:
        arrow = " → ".join(money(v) for _, v in tr)
        rng = f"（{' → '.join(p[0][5:7].lstrip('0') + '.' + p[0][8:10].lstrip('0') for p in tr)}）"
        els += [{"tag": "markdown", "content": f"🔥 近日趋势 {rng}\n**{arrow}**"},
                {"tag": "hr"}]
    medals = ["1️⃣", "2️⃣", "3️⃣"]
    top_lines = "\n".join(f"{medals[i]} {n} — {money(v)}（{pct(c)}）"
                          for i, (n, v, c) in enumerate(d["top"]))
    els += [{"tag": "markdown", "content": f"🏆 **Top{len(d['top'])} 产品**\n{top_lines}"},
            {"tag": "hr"}]
    if d["warn"]:
        wl = []
        for n, pv, cv, chg in d["warn"]:
            icon = "🔻" if chg < 0 else "🟢"
            wl.append(f"{icon} {n}: {money(pv)} → {money(cv)}（{chg * 100:+.1f}%）")
        els.append({"tag": "markdown", "content":
                    f"⚠️ **收益波动预警**（收益>{money(WARN_REV_MIN)[:-3]} 且 波动>{int(WARN_CHG_MIN * 100)}%）\n"
                    + "\n".join(wl)})
    else:
        els.append({"tag": "markdown", "content": "⚠️ **收益波动预警**　今日无大幅波动产品"})
    head = (f"💸 **ROI 倒挂 Top{len(d['roi_worst'])}**"
            f"（覆盖 {d['cost_hit']}/{d['cost_all']} 产品）")
    if d["roi_worst"]:
        rl = [f"🔻 {n}: 消耗 {money(c)} → 收益 {money(v)}（ROI {r:.2f}）"
              for n, c, v, r in d["roi_worst"]]
        body = "\n".join(rl)
    else:
        body = "今日无 ROI 倒挂产品"
    els += [{"tag": "hr"}, {"tag": "markdown", "content": head + "\n" + body}]
    color = "red" if d["chg"] <= -0.15 or health_bad else ("orange" if d["chg"] < 0 else "blue")
    return {"config": {"wide_screen_mode": True},
            "header": {"template": color,
                       "title": {"tag": "plain_text", "content": f"📊 产品收益日报 · {day_label}"}},
            "elements": els}


def analyze_dapan_consume(rows=None):
    """消耗日报口径：只看消耗，不含收益 / 展示 / ROI / eCPM。"""
    if rows is None:
        rows = search_records(TABLE_DAPAN,
                              ["产品名", "平台", "数据日", "买量消耗", "前日消耗", "消耗日环比"])
    days = {}
    for r in rows:
        v = r.get("数据日")
        if isinstance(v, (int, float)):
            d = datetime.fromtimestamp(v / 1000).strftime("%Y-%m-%d")
        else:
            d = str(v or "")[:10]
        if d:
            days.setdefault(d, []).append(r)
    if not days:
        raise RuntimeError("本轮没有可用于消耗日报的已确认数据。")
    latest = max(days)
    rs = days[latest]
    total = sum(num(r.get("买量消耗")) for r in rs)
    prev = sum(num(r.get("前日消耗")) for r in rs)
    hit = [r for r in rs if num(r.get("买量消耗")) > 0]
    top = sorted(rs, key=lambda r: -num(r.get("买量消耗")))[:3]
    warn = []
    for r in rs:
        c, pc, chg = num(r.get("买量消耗")), num(r.get("前日消耗")), num(r.get("消耗日环比"))
        if c > COST_MIN and abs(chg) > COST_CHG_MIN:
            warn.append((str(first(r.get("产品名"))), pc, c, chg))
    warn.sort(key=lambda t: t[3])
    # 停投：前日有消耗（超过门槛）、今日为 0
    stopped = [(str(first(r.get("产品名"))), num(r.get("前日消耗"))) for r in rs
               if num(r.get("买量消耗")) == 0 and num(r.get("前日消耗")) > COST_MIN]
    stopped.sort(key=lambda t: -t[1])
    return {"date": latest, "products": len(rs), "cost": total, "prev_cost": prev,
            "chg": (total / prev - 1) if prev else 0, "hit": len(hit),
            "top": [(str(first(r.get("产品名"))), num(r.get("买量消耗")), num(r.get("消耗日环比")))
                    for r in top],
            "warn": warn, "stopped": stopped}


def trend_consume():
    """消耗趋势：读快照表的「总消耗」（由广告卡片每天写入；没有数据时该板块自动隐藏）。"""
    rows = search_records(TABLE_SNAPSHOT, ["日期", "总消耗"])
    pts = []
    for r in rows:
        v = r.get("日期")
        ts = v if isinstance(v, (int, float)) else None
        if ts and num(r.get("总消耗")) > 0:
            pts.append((datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d"), num(r.get("总消耗"))))
    return sorted(pts)[-3:]


def build_card_consume(d, tr):
    """消耗日报卡片：只有消耗相关内容。"""
    day_label = f"{int(d['date'][5:7])}月{int(d['date'][8:10])}日"
    els = [{"tag": "markdown", "content":
            f"**{d['date'][5:7].lstrip('0')}.{d['date'][8:10].lstrip('0')} 消耗总览**\n"
            f"💸 消耗: **{money(d['cost'])}**（{pct(d['chg'])}）\n"
            f"🎯 有消耗产品: **{d['hit']}/{d['products']}**"},
           {"tag": "hr"}]
    if len(tr) >= 2:
        arrow = " → ".join(money(v) for _, v in tr)
        rng = f"（{' → '.join(p[0][5:7].lstrip('0') + '.' + p[0][8:10].lstrip('0') for p in tr)}）"
        els += [{"tag": "markdown", "content": f"🔥 近日消耗趋势 {rng}\n**{arrow}**"},
                {"tag": "hr"}]
    medals = ["1️⃣", "2️⃣", "3️⃣"]
    top_lines = "\n".join(f"{medals[i]} {n} — {money(v)}（{pct(c)}）"
                          for i, (n, v, c) in enumerate(d["top"]))
    els += [{"tag": "markdown", "content": f"🏆 **消耗 Top{len(d['top'])} 产品**\n{top_lines}"},
            {"tag": "hr"}]
    lines = []
    for n, pv, cv, chg in d["warn"]:
        lines.append(f"{'🔻' if chg < 0 else '🟢'} {n}: {money(pv)} → {money(cv)}（{chg * 100:+.1f}%）")
    for n, pv in d["stopped"]:
        lines.append(f"⏸ {n}: 今日停投（前日 {money(pv)} → 今日 $0.00）")
    els.append({"tag": "markdown", "content":
                f"⚠️ **消耗异常预警**（消耗>{money(COST_MIN)[:-3]} 且波动>{int(COST_CHG_MIN * 100)}%，含停投）\n"
                + ("\n".join(lines) if lines else "今日无异常")})
    color = "red" if d["chg"] <= -0.15 else ("orange" if d["chg"] < 0 else "blue")
    return {"config": {"wide_screen_mode": True},
            "header": {"template": color,
                       "title": {"tag": "plain_text", "content": f"💸 消耗日报 · {day_label}"}},
            "elements": els}


def build_local_report(consume=False, dashboard=None):
    """只读取表格或本轮已确认值；不写远程快照、看板，也不调用消息接口。"""
    coverage = None
    if dashboard is not None:
        records = dashboard["records"]
        rows = [row["fields"] for row in records
                if isinstance(row.get("fields"), dict)
                and all(isinstance(row["fields"].get(key), (int, float))
                        and not isinstance(row["fields"][key], bool)
                        and math.isfinite(row["fields"][key])
                        for key in ("买量消耗", "前日消耗", "消耗日环比"))]
        if any(row.get("数据日") != dashboard["dataDate"] for row in rows):
            raise RuntimeError("本轮大盘记录的数据日不一致，不生成消耗日报。")
        data = analyze_dapan_consume(rows)
        if data["date"] != dashboard["dataDate"]:
            raise RuntimeError("本轮大盘记录的数据日不一致，不生成消耗日报。")
        coverage = {"total": dashboard["total"], "included": len(rows),
                    "excluded": dashboard["total"] - len(rows)}
    else:
        data = analyze_dapan_consume() if consume else analyze_dapan()
    notes, history = [], []
    if dashboard is None:
        try:
            history = trend_consume() if consume else trend()
        except Exception:
            notes.append("近日趋势暂时无法读取，本报表未包含趋势。")
    card = (build_card_consume(data, history) if consume
            else build_card(data, history, [], False))
    parts = [card["header"]["title"]["content"]]
    parts.extend(element["content"].replace("**", "") for element in card["elements"]
                 if element.get("tag") == "markdown")
    parts.extend(notes)
    if coverage and coverage["excluded"]:
        parts.append(f"统计口径：本轮已确认 {coverage['included']}/{coverage['total']} 条大盘记录，"
                     f"其余 {coverage['excluded']} 条未纳入，以上为部分统计。")
    result = {"schemaVersion": 1, "kind": "consume" if consume else "ads",
              "runId": sync_log.current_run_id(),
              "generatedAt": datetime.now().astimezone().isoformat(),
              "dataDate": data["date"], "text": "\n\n".join(parts)}
    if dashboard is not None:
        result.update(source="confirmed_dashboard", dashboardRunId=dashboard["dashboardRunId"],
                      coverage=coverage)
    return result


def main():
    target = Path(__file__).resolve().parent / "finance-report.json"
    if target.exists():
        target.unlink()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=["local"], default="local")
    parser.add_argument("--consume", action="store_true")
    parser.add_argument("--from-run", action="store_true", help="只使用本轮已确认的大盘记录")
    parser.add_argument("--dates", type=normalize_dates, help="消耗更新日期；日报使用最后一天")
    args = parser.parse_args()
    if args.dates and (not args.consume or not args.from_run):
        parser.error("--dates 需同时使用 --consume 和 --from-run。")
    from run_consume import dapan_stale_reason
    stale = dapan_stale_reason(args.dates) if args.dates else dapan_stale_reason()
    if stale:
        raise RuntimeError("大盘日期校验未通过，不生成日报：" + stale)
    dashboard = None
    if args.from_run:
        dashboard = json.loads((target.parent / "dapan-result.json").read_text(encoding="utf-8"))
        if (not args.consume or dashboard.get("schemaVersion") != 1
                or not sync_log.current_run_id() or dashboard.get("runId") != sync_log.current_run_id()
                or not isinstance(dashboard.get("dashboardRunId"), str)
                or not isinstance(dashboard.get("total"), int) or isinstance(dashboard["total"], bool)
                or not isinstance(dashboard.get("records"), list)
                or not 0 < len(dashboard["records"]) <= dashboard["total"]):
            raise RuntimeError("大盘记录与本轮运行不匹配，不生成消耗日报。")
    report = build_local_report(args.consume, dashboard)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, target)
    print("已生成本地日报，可在工作台复制分享。")


if __name__ == "__main__":
    main()
