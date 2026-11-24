#!/usr/bin/env python3
"""消耗同步（同事机器专用入口）。

做四件事：
  1. 刷新「消耗同步规则」快照（只读消耗规则表，不依赖广告规则库，因此不需要广告库权限）
  2. 同步消耗数据：full_review.py --type consume
  3. 生成本地消耗日报（只含消耗内容，不含收益/ROI），由 Agent 展示供用户复制
  4. 把本次运行的审计记录推到飞书中转表「同步运行日志」，供主机器的本地库拉取

用法：
  python3 run_consume.py [--dry] [--dates YYYY-MM-DD,YYYY-MM-DD] [--no-card] [--no-push]

建议这台机器设一次环境变量，便于在中转表里区分来源：
  export SYNC_MACHINE=同事名字
"""
import datetime
import json
import os
import subprocess
import sys
import time

from codex_lark_adapter import list_records
import sync_log
from sync_dates import parse_dates

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "Nmc8b6FAxa62VZsQwIfck1Bcn9f"        # 消耗同步配置中心
CONSUME_TID = "tbldtJZblqwpuO9w"            # 网赚消耗同步规则
DAPAN_TID = "tblidqds37MNgYwC"              # 每日大盘与异动监控
TOPON_SRC = "https://iwfeys1lhfi.feishu.cn/wiki/C59YwLnEmiLTfbkOCjScIf7rnQe"


def dapan_stale_reason(dates=None):
    """显式日期核对本轮大盘回执；旧调用核对广告源的最新日期。

    返回 None 表示日期匹配，否则返回未能确认的原因。
    """
    try:
        if dates:
            with open(os.path.join(HERE, 'dapan-result.json')) as source:
                dashboard = json.load(source)
            if (dashboard.get('schemaVersion') != 1 or not sync_log.current_run_id()
                    or dashboard.get('runId') != sync_log.current_run_id()
                    or dashboard.get('dataDate') != dates[-1] or not dashboard.get('records')
                    or any(row.get('fields', {}).get('数据日') != dates[-1] for row in dashboard['records'])):
                return '本轮大盘数据日与所选更新日期不一致'
            return None
        import full_review as F
        src = F.resolve_obj(TOPON_SRC, {})
        rows = F.get_values(src, "0uKWKA!A2:A60000")
        src_max = max((int(r[0]) for r in rows
                       if r and isinstance(r[0], (int, float)) and 45000 < r[0] < 47000),
                      default=None)
        if src_max is None:
            return "无法确定广告源最新日期"
        expect = (datetime.date(1899, 12, 30) + datetime.timedelta(days=src_max)).isoformat()
        days = []
        for r in list_records(BASE, DAPAN_TID):
            d = r["fields"].get("数据日")
            if isinstance(d, (int, float)):
                serial = int(round(d / 86400000.0 + 25569))
                days.append((datetime.date(1899, 12, 30) + datetime.timedelta(days=serial)).isoformat())
            elif isinstance(d, str) and len(d) >= 10:
                days.append(d[:10])
        if not days:
            return "大盘表没有可识别的数据日"
        got = max(days)
        if got < expect:
            return f"大盘数据日 {got} 落后于广告源最新日期 {expect}"
        return None
    except Exception as exc:
        return f"校验异常（{type(exc).__name__}: {str(exc)[:80]}），无法确认大盘日期"


def hm():
    return time.strftime("%H:%M:%S")


def snapshot_consume():
    """刷新消耗规则快照。

    注意：rules_full.json 是「同步」与「大盘汇总」共用的一份快照，
    dapan_sync.py 需要其中的广告规则（产品名+平台 -> 目标表）才能匹配大盘行，
    因此这里只能替换 consume 段，绝不能把 topon/max/admob 清空（否则大盘会 0/75 静默跳过）。
    """
    recs = list_records(BASE, CONSUME_TID)
    path = os.path.join(HERE, "rules_full.json")
    data = {"topon": [], "max": [], "admob": [], "consume": []}
    kept = False
    if os.path.exists(path):
        try:
            with open(path) as fp:
                old = json.load(fp)
            for k in ("topon", "max", "admob"):
                data[k] = old.get(k) or []
            kept = True
        except Exception as exc:  # 快照损坏时退回空广告段，但下面会显式告警
            print(f"  ⚠ 旧快照读取失败({type(exc).__name__})，广告段将为空")
    data["consume"] = recs
    with open(path, "w") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
    print(f"  规则 consume: {len(recs)} 条"
          f"（{'保留' if kept else '未找到旧快照，无法保留'}广告段 "
          f"topon {len(data['topon'])} / max {len(data['max'])} / admob {len(data['admob'])}）")
    if not (data["topon"] or data["max"] or data["admob"]):
        print("  ⚠ 广告段为空：本机的「大盘刷新/卡片」将无法匹配大盘行（会显式失败而不是静默跳过）")


def main():
    dates = parse_dates()
    date_args = ['--dates', ','.join(dates)] if dates else []
    dry = "--dry" in sys.argv
    no_push = "--no-push" in sys.argv
    # --no-card 保留兼容；本入口始终不发送消息。
    report_path = os.path.join(HERE, "finance-report.json")
    if os.path.exists(report_path):
        os.unlink(report_path)
    trigger = os.environ.get("SYNC_TRIGGER") or ("manual" if "--manual" in sys.argv else "auto")

    run_id = sync_log.new_run(trigger=trigger, argv=" ".join([sys.executable] + sys.argv),
                              mode="consume-dry" if dry else "consume")
    print(f"### 运行编号 {run_id}  机器 {sync_log.machine_id()}  模式 {'dry' if dry else '正式'}")

    if dates:
        print(f"更新日期：{dates[0]} 至 {dates[-1]}（{len(dates)} 天）；大盘和日报数据日：{dates[-1]}")

    t = hm()
    print("### 1. 刷新消耗规则快照")
    snapshot_consume()
    sync_log.log_step("snapshot", ok=True, started_at=t, finished_at=hm(), summary="刷新消耗规则")

    print("\n### 2. 消耗同步（源表 -> 目标表）")
    t = hm()
    cmd = [sys.executable, "full_review.py", "--type", "consume"] + date_args + (["--dry"] if dry else [])
    rc = subprocess.run(cmd, cwd=HERE).returncode
    sync_log.log_step("sync:consume", ok=(rc == 0), exit_code=rc, started_at=t, finished_at=hm())
    print(f"== 退出码 {rc} ==")

    if rc != 0:
        # A failed shared source/entry cannot produce independent rule results.
        sync_log.finish_run(ok=False, note='共享源数据或同步入口未完成，已保存本轮错误')
        print('共享同步入口未完成，无法继续依赖该结果的大盘与金额日报。')
        sys.exit(rc)
    try:
        with open(os.path.join(HERE, 'full_review_result_consume.json')) as source:
            rows = json.load(source)
        failed_products = [row['name'] for row in rows if row.get('ok') is not True]
    except (OSError, ValueError, TypeError, KeyError):
        failed_products = []
        sync_log.log_step('results:consume', ok=False, summary='本轮消耗逐项结果不可读取，请核对本轮日志')
    workflow_ok = not failed_products
    if dry:
        sync_log.finish_run(ok=workflow_ok, note='所有消耗规则预演结束，问题统一返回工作台')
        print('全部规则预演结束；本轮问题将在工作台文字报表中汇总。')
        return

    print('\n### 2.5 刷新大盘（逐项处理，跳过本轮消耗未完成的产品）')
    t = hm()
    dashboard_env = {**os.environ, 'SYNC_FAILED_CONSUME_PRODUCTS': json.dumps(failed_products, ensure_ascii=False)}
    rc_d = subprocess.run([sys.executable, 'dapan_sync.py'] + date_args, cwd=HERE, env=dashboard_env).returncode
    sync_log.log_step('dapan', ok=(rc_d == 0), exit_code=rc_d, started_at=t, finished_at=hm(),
                      summary='' if rc_d == 0 else '大盘步骤未完成，消耗逐项结果保留，继续收尾与文字报表')
    stale = (dapan_stale_reason(dates) if dates else dapan_stale_reason()) if rc_d == 0 else '大盘步骤未完成'
    if rc_d == 0 and stale:
        sync_log.log_step('dapan:date', ok=False, summary=stale)
    workflow_ok = workflow_ok and rc_d == 0 and not stale
    if rc_d == 0 and not stale:
        print('\n### 3. 生成本地消耗日报')
        t = hm()
        rc_report = subprocess.run([sys.executable, 'sync_daily_summary.py', 'local', '--consume', '--from-run'] + date_args, cwd=HERE).returncode
        sync_log.log_step('report:consume', ok=(rc_report == 0), exit_code=rc_report, started_at=t, finished_at=hm(),
                          summary='' if rc_report == 0 else '金额日报未生成，继续返回本轮文字清单')
        workflow_ok = workflow_ok and rc_report == 0
    else:
        print('大盘或日期尚未确认，执行结果单独返回；不复用历史日报。')

    if no_push:
        print('（--no-push：本次不推送中转表）')
    else:
        print('\n### 4. 推送审计记录到飞书中转表')
        try:
            sync_log.push_run(run_id)
        except Exception as error:
            workflow_ok = False
            sync_log.log_step('push_relay', ok=False, summary=str(error))
    sync_log.finish_run(ok=workflow_ok, note='本轮所有独立项目处理结束，未完成项目统一返回文字报表')
    print('### 本轮处理结束')


if __name__ == "__main__":
    main()
