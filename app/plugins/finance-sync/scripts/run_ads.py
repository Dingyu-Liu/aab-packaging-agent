#!/usr/bin/env python3
"""广告同步（可放在任意一台机器上执行）。

做三件事：
  1. 刷新广告规则快照（topon / max / admob，只读「广告同步规则」base，不需要消耗规则库权限）
  2. 按正确顺序同步：topon 先跑，max / admob 后置（它们是「叠加 topon」型来源）
  3. 把本次运行的审计记录推到飞书中转表「同步运行日志」，供汇总机器的本地库拉取

用法：
  python3 run_ads.py [--dry] [--serial] [--no-push]

  默认 max / admob 在 topon 跑完后并发；--serial 逐个串行（省资源）。
  大步骤说明：本脚本只做广告（topon/max/admob），不碰消耗、大盘、卡片。

建议这台机器设一次环境变量，便于在中转表里区分来源：
  export SYNC_MACHINE=机器名
"""
import json
import os
import subprocess
import sys
import time

from codex_lark_adapter import list_records
import sync_log

HERE = os.path.dirname(os.path.abspath(__file__))
AD_BASE = "RrB6bBje3acplSsE2mscswkhnDF"      # 广告同步规则（独立 base）
# (规则类型, base_token, table_id) —— 只含广告三类
AD_RULE_TABLES = [("topon", AD_BASE, "tbluixPbjbNY5Z6Y"),
                  ("max", AD_BASE, "tblSlhf6YYwmJmo7"),
                  ("admob", AD_BASE, "tblu5mcci8wpDJqL")]


def _hm():
    return time.strftime("%H:%M:%S")


def snapshot_rules():
    """只刷新广告分段，保留本轮已准备的消耗分段。"""
    out = {"topon": [], "max": [], "admob": [], "consume": []}
    path = os.path.join(HERE, "rules_full.json")
    if os.path.exists(path):
        with open(path) as fp:
            previous = json.load(fp)
        if not isinstance(previous, dict) or not isinstance(previous.get("consume", []), list):
            raise ValueError("Invalid consume snapshot segment")
        out["consume"] = previous.get("consume", [])
    for name, base, tid in AD_RULE_TABLES:
        out[name] = list_records(base, tid)
        print(f"  规则 {name}: {len(out[name])} 条")
    with open(os.path.join(HERE, "rules_full.json"), "w") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)


def merge_results():
    """合并各类型结果并打印合计（与 run_all 一致）。"""
    merged = []
    for t in ("topon", "max", "admob"):
        fp = os.path.join(HERE, f"full_review_result_{t}.json")
        if os.path.exists(fp):
            try:
                merged += json.load(open(fp))
            except json.JSONDecodeError:
                print(f"  警告: {t} 结果文件解析失败")
    if not merged:
        return
    with open(os.path.join(HERE, "full_review_result.json"), "w") as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)
    ok = sum(1 for r in merged if r["ok"])
    print(f"合计: 成功 {ok}/{len(merged)}, 写入 {sum(r['写'] for r in merged)} 格, "
          f"跳过 {sum(r['跳过'] for r in merged)}, 缺行补日期 {sum(r['缺行'] for r in merged)}")


def sync_ads(dry, serial):
    """广告同步编排：topon 先，max/admob 后置。

    顺序不能乱：像 IOS_Art Story: Jigsaw HD、IOS_Spiral Spin Bolt Out 这类
    「MAX 叠加 topon」产品，max/admob 规则与 topon 规则会写同一批单元格
    （收益 / 展示 / eCPM），且 max/admob 写的是「topon + 全部叠加源」的合计值。
    若与 topon 并发，topon 的结果可能后落盘、把合计覆盖成单侧值
    （收益被打回接近 0 → ROI 假倒挂，历史上踩过这个坑）。
    """
    print("\n### 2. 广告同步（源表 -> 目标表，topon 先、max/admob 后置）")
    t0 = time.time()
    codes = {}
    # 清掉上一次的结果文件：否则某个类型中途失败时，合并汇总会读到上一轮的旧数字（误导）
    for t in ("topon", "max", "admob"):
        fp = os.path.join(HERE, f"full_review_result_{t}.json")
        if os.path.exists(fp):
            os.remove(fp)

    def run_type(t):
        t1 = _hm()
        cmd = [sys.executable, "full_review.py", "--type", t] + (["--dry"] if dry else [])
        rc = subprocess.run(cmd, cwd=HERE).returncode
        codes[t] = rc
        sync_log.log_step(f"sync:{t}", ok=(rc == 0), exit_code=rc, started_at=t1, finished_at=_hm())
        print(f"  [{t}] 退出码 {rc}，完成于 {_hm()}")

    if serial:
        for t in ("topon", "max", "admob"):
            run_type(t)
    else:
        run_type("topon")                      # 必须最先，叠加源依赖它的结果
        t1 = _hm()
        procs = []
        for t in ("max", "admob"):
            procs.append((t, subprocess.Popen(
                [sys.executable, "full_review.py", "--type", t] + (["--dry"] if dry else []), cwd=HERE)))
            time.sleep(0.5)
        for t, p in procs:
            codes[t] = p.wait()
        for t, _ in procs:
            sync_log.log_step(f"sync:{t}", ok=(codes[t] == 0), exit_code=codes[t],
                              started_at=t1, finished_at=_hm())
            print(f"  [{t}] 退出码 {codes[t]}，完成于 {_hm()}")
    print(f"  广告同步耗时 {time.time() - t0:.0f}s")
    merge_results()
    return codes


def main():
    dry = "--dry" in sys.argv
    serial = "--serial" in sys.argv
    no_push = "--no-push" in sys.argv
    trigger = os.environ.get("SYNC_TRIGGER") or ("manual" if "--manual" in sys.argv else "auto")

    run_id = sync_log.new_run(trigger=trigger, argv=" ".join([sys.executable] + sys.argv),
                              mode="ads-dry" if dry else "ads")
    print(f"### 运行编号 {run_id}  机器 {sync_log.machine_id()}  模式 {'dry' if dry else '正式'}")
    ok_all = True

    print("\n### 1. 刷新广告规则快照")
    t = _hm()
    snapshot_rules()
    sync_log.log_step("snapshot", ok=True, started_at=t, finished_at=_hm(), summary="刷新广告规则快照")

    codes = sync_ads(dry, serial)
    ok_all = ok_all and all(rc == 0 for rc in codes.values())

    if dry:
        sync_log.finish_run(ok=ok_all, note=f"广告同步 dry（{sync_log.machine_id()}）")
        print("\n（dry 运行：不写目标表、不推送中转）")
        return

    # 3. 审计记录推送到飞书中转表（默认推送，--no-push 关闭；失败不影响同步结果）
    push_note = "未推中转"
    if no_push:
        print("\n### 3. 跳过推送中转表（--no-push）")
    else:
        print("\n### 3. 推送审计记录到飞书中转表")
        t = _hm()
        total = 0
        try:
            total = len(sync_log.relay_rows_for_run(run_id))
            pushed = sync_log.push_run(run_id)
            push_note = f"已推中转 {pushed}/{total} 条"
            if pushed < total:
                print(f"  注意：只推成功 {pushed}/{total} 条，可补推: python3 sync_relay.py push --run {run_id}")
        except Exception as exc:
            push_note = f"推中转异常({type(exc).__name__})"
            print(f"  推送异常: {exc}\n  可补推: python3 sync_relay.py push --run {run_id}")
        sync_log.log_step("push_relay", ok=("失败" not in push_note and "异常" not in push_note),
                          started_at=t, finished_at=_hm(), summary=push_note)

    print("\n### 广告同步完成")
    sync_log.finish_run(ok=ok_all, note=f"广告同步（{sync_log.machine_id()}）；{push_note}")


if __name__ == "__main__":
    main()
