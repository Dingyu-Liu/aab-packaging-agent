#!/usr/bin/env python3
"""Base record compatibility adapter; authorization belongs to the server.

SYNC_LARK_CLI selects an executable CLI. FEISHU_TEAM_RUNNER selects an
explicit Bash launcher using its `cli` subcommand. No desktop discovery or
credentials are packaged, and an invalid explicit setting fails closed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime


def cli_command(args: list[str]) -> list[str]:
    path = os.environ.get("SYNC_LARK_CLI")
    if path:
        if not os.path.isabs(path) or not os.path.isfile(path) or not os.access(path, os.X_OK):
            raise RuntimeError("SYNC_LARK_CLI must name an executable absolute file")
        return [path, *args]
    runner = os.environ.get("FEISHU_TEAM_RUNNER")
    if runner:
        if not os.path.isabs(runner) or not os.path.isfile(runner):
            raise RuntimeError("FEISHU_TEAM_RUNNER must name an absolute Bash launcher")
        return ["/bin/bash", runner, "cli", *args]
    raise RuntimeError("Server deployment requires SYNC_LARK_CLI or FEISHU_TEAM_RUNNER")


def cli_error(result) -> RuntimeError:
    """Keep the bridge's error code without forwarding arbitrary CLI output."""
    message = "Feishu CLI exited with status %s" % result.returncode
    match = re.search(r"飞书表格操作未通过（(\d+)）", result.stderr or "")
    if match:
        code = match.group(1)
        detail = "当前账号缺少目标表格的访问或编辑权限" if code == "91403" else "请核对飞书授权、目标表格权限及请求参数"
        message += f"；飞书错误码 {code}：{detail}。"
    return RuntimeError(message)


def _run_cli(args: list[str], attempts: int = 3) -> dict:
    for attempt in range(attempts):
        p = subprocess.run(cli_command(args), capture_output=True, text=True)
        if p.returncode != 0:
            raise cli_error(p)
        try:
            data = json.loads(p.stdout or "")
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict) and data.get("ok") is True:
            return data
        if attempt + 1 < attempts:
            time.sleep(1)
    raise RuntimeError("Feishu CLI did not return a successful JSON response")


def _normalize_cell(value, field_type: str):
    if field_type == "select" and isinstance(value, list) and len(value) == 1:
        return value[0]
    if field_type == "datetime" and isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return value
    return value


def parse_record_list(envelope: dict) -> tuple[list[dict], bool]:
    data = envelope.get("data") or {}
    names = data.get("fields") or []
    types = data.get("field_type_list") or [""] * len(names)
    ids = data.get("record_id_list") or []
    rows = data.get("data") or []
    records = []
    for index, row in enumerate(rows):
        fields = {
            name: _normalize_cell(row[col] if col < len(row) else None,
                                  types[col] if col < len(types) else "")
            for col, name in enumerate(names)
        }
        records.append({"record_id": ids[index], "fields": fields})
    return records, bool(data.get("has_more"))


def list_records(base_token: str, table_id: str, field_names=None, limit_total=None) -> list[dict]:
    """读取记录列表。

    limit_total 仅用于自检等场景做「抽样」：达到条数即停止翻页，
    避免对上万条的中转表做几十次分页请求（容易触发限流）。
    """
    result = []
    offset = 0
    limit = 200 if limit_total is None else max(1, min(200, int(limit_total)))
    while True:
        args = [
            "base", "+record-list", "--base-token", base_token,
            "--table-id", table_id, "--offset", str(offset),
            "--limit", str(limit), "--format", "json", "--as", "user",
        ]
        for name in field_names or []:
            args.extend(["--field-id", name])
        records, has_more = parse_record_list(_run_cli(args))
        result.extend(records)
        if not has_more or not records:
            return result
        if limit_total is not None and len(result) >= int(limit_total):
            return result
        offset += len(records)


def _looks_like_datetime_field(name: str) -> bool:
    return name.endswith("时间") or name in {
        "日期", "数据日", "预估口径起始日", "生效起始日", "更新时间"
    }


def to_cli_fields(fields: dict) -> dict:
    converted = {}
    for name, value in fields.items():
        if _looks_like_datetime_field(name) and isinstance(value, (int, float)) and value > 10**11:
            value = datetime.fromtimestamp(value / 1000).strftime("%Y-%m-%d %H:%M:%S")
        converted[name] = value
    return converted


class RecordUpdateError(RuntimeError):
    def __init__(self, failures, completed_ids):
        self.failures = failures
        self.completed_ids = completed_ids
        super().__init__('；'.join(f'{row["record_id"]}: {row["error"]}' for row in failures))


def update_records(base_token: str, table_id: str, records: list[dict]) -> None:
    """Batch independent records through the App bridge, retaining per-record receipts.

    Older CLI deployments keep their existing command. A rejected batch or a
    missing receipt falls back to individual idempotent assignments so one bad
    product does not prevent other products from completing. Duplicate record
    IDs retain their original write order.
    """
    completed, failures = [], []

    def update_one(record):
        try:
            _run_cli([
                "base", "+record-upsert", "--base-token", base_token,
                "--table-id", table_id, "--record-id", record["record_id"],
                "--json", json.dumps(to_cli_fields(record["fields"]), ensure_ascii=False),
                "--as", "user",
            ])
            completed.append(record['record_id'])
        except Exception as error:
            failures.append({'record_id': record['record_id'], 'error': str(error)})

    batch = (bool(os.environ.get('PARTNER_FEISHU_BRIDGE_URL'))
             and len({row['record_id'] for row in records}) == len(records))
    size = 50 if batch else 1
    for offset in range(0, len(records), size):
        chunk = records[offset:offset + size]
        acknowledged = set()
        if batch and len(chunk) > 1:
            try:
                reply = _run_cli([
                    'api', 'POST',
                    f'/open-apis/bitable/v1/apps/{base_token}/tables/{table_id}/records/batch_update',
                    '--data', json.dumps({'records': chunk}, ensure_ascii=False),
                ])
                acknowledged = {row['record_id'] for row in (reply.get('data') or {}).get('records', [])
                                if isinstance(row, dict) and isinstance(row.get('record_id'), str)}
            except Exception:
                # A batch failure does not identify which rows can be written.
                # Repeating these value assignments is safe; confirm each row.
                pass
        for record in chunk:
            if record['record_id'] in acknowledged:
                completed.append(record['record_id'])
            else:
                update_one(record)
        count = offset + len(chunk)
        if batch or count % 20 == 0 or count == len(records):
            print(f'  Base 回写进度: {count}/{len(records)}（已确认 {len(completed)}，未完成 {len(failures)}）', flush=True)
    if failures:
        raise RecordUpdateError(failures, completed)


def create_record(base_token: str, table_id: str, fields: dict) -> dict:
    return _run_cli([
        "base", "+record-upsert", "--base-token", base_token,
        "--table-id", table_id,
        "--json", json.dumps(to_cli_fields(fields), ensure_ascii=False),
        "--as", "user",
    ])
