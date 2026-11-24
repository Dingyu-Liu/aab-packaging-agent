# Derived from a user-supplied H5 sync asset. Original ownership retained.
# Fixed business identifiers removed; controlled commands only. See provenance.json.
import os
import sys
import json
import csv
import io
import re
import argparse
import subprocess
import concurrent.futures
from datetime import datetime, timedelta
from urllib.parse import quote
FEISHU_SH = os.environ.get('PARTNER_H5_FEISHU_LAUNCHER', '')
DEFAULT_SOURCE_TOKEN = os.environ.get('PARTNER_H5_SOURCE_TOKEN', '')
DEFAULT_PIVOT_SHEET = os.environ.get('PARTNER_H5_SOURCE_SHEET_ID', '')
DEFAULT_RAW_SHEET = os.environ.get('PARTNER_H5_RAW_SHEET_ID', '')
DEFAULT_BASE_TOKEN = os.environ.get('PARTNER_H5_BASE_TOKEN', '')
DEFAULT_TABLE_ID = os.environ.get('PARTNER_H5_TABLE_ID', '')
DEFAULT_PREVIEW_USER = os.environ.get('PARTNER_H5_PREVIEW_USER', '')
DEFAULT_GROUP_CHAT = os.environ.get('PARTNER_H5_GROUP_CHAT', '')

def _annotated_rows(raw):
    """Preserve physical row numbers while letting csv handle quoted fields."""
    numbers = []
    lines = []
    for line in raw.splitlines():
        match = re.match(r'^\[row=(\d+)\]\s?(.*)', line)
        if not match:
            raise ValueError('来源 CSV 缺少可靠行号')
        numbers.append(int(match.group(1)))
        lines.append(match.group(2))
    rows = list(csv.reader(lines))
    if len(rows) != len(numbers) or len(set(numbers)) != len(numbers):
        raise ValueError('来源 CSV 行号不完整或重复')
    return dict(zip(numbers, rows))


def _source_date(value):
    value = str(value).strip()
    if re.fullmatch(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}', value):
        return datetime.strptime(value.replace('/', '-'), '%Y-%m-%d').strftime('%Y-%m-%d')
    if re.fullmatch(r'\d+(?:\.0+)?', value):
        serial = int(float(value))
        if 30000 < serial < 100000:
            return (datetime(1899, 12, 30) + timedelta(days=serial)).strftime('%Y-%m-%d')
    raise ValueError('来源存在无法识别的日期')


def _settled_source(args):
    """Rebuild an empty pivot from explicitly configured, already-settled rows.

    These values have already been split upstream. Never apply another ratio,
    substitute a missing metric, or use this fallback before its effective date.
    """
    sheet_id = DEFAULT_RAW_SHEET
    basis = os.environ.get('PARTNER_H5_RAW_REVENUE_BASIS', '')
    from_date = os.environ.get('PARTNER_H5_RAW_FROM_DATE', '')
    dates = args.dates.split(',') if args.dates else []
    if basis != 'settled' or not from_date or not dates or any(day < from_date for day in dates):
        raise ValueError('透视页为空；备用来源未明确已结算口径或目标日期早于已校验范围')
    metadata = run_feishu_cli(['api', 'GET', f'/open-apis/sheets/v3/spreadsheets/{args.source_token}/sheets/query'])
    sheets = metadata.get('data', {}).get('sheets', [])
    matches = [sheet for sheet in sheets if sheet.get('sheet_id') == sheet_id]
    if len(matches) != 1:
        raise ValueError('备用结算来源工作表不存在或不唯一')
    row_count = matches[0].get('grid_properties', {}).get('row_count')
    if not isinstance(row_count, int) or isinstance(row_count, bool) or not 1 < row_count <= 1000000:
        raise ValueError('备用结算来源行数不可确认')

    def read(cell_range):
        result = run_feishu_cli(['sheets', '+csv-get', '--spreadsheet-token', args.source_token,
                                '--sheet-id', sheet_id, '--range', cell_range])
        raw = result.get('data', {}).get('annotated_csv')
        if not isinstance(raw, str):
            raise ValueError('备用结算来源没有返回 CSV 数据')
        return _annotated_rows(raw)

    header = read('A1:G1').get(1, [])
    if header != ['H5方', 'Date', '产品', '链接', '收益', '展示', '点击']:
        raise ValueError('备用结算来源表头与已校验结构不一致')
    index_rows = read(f'B1:B{row_count}')
    if len(index_rows) != row_count or min(index_rows, default=0) != 1 or max(index_rows, default=0) != row_count:
        raise ValueError('结算来源日期索引缺行，不能汇总不完整数据')
    wanted, seen_dates = {}, set()
    for number, cells in index_rows.items():
        if number == 1 or not cells or not cells[0].strip():
            continue
        date = _source_date(cells[0])
        seen_dates.add(date)
        if date in dates:
            wanted[number] = date
    if not wanted:
        raise ValueError('结算来源没有目标日期，最新可用日期：' + (max(seen_dates) if seen_dates else '无'))
    blocks = sorted({(number - 1) // 5000 for number in wanted})
    def block_rows(block):
        start = block * 5000 + 1
        end = min((block + 1) * 5000, row_count)
        return read(f'A{start}:G{end}')
    all_rows = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(blocks))) as pool:
        for rows in pool.map(block_rows, blocks):
            all_rows.update(rows)
    if any(number not in all_rows for number in wanted):
        raise ValueError('结算来源分页缺行，不能汇总不完整数据')
    products, issues, identities = {}, {}, set()
    for number, date in wanted.items():
        row = all_rows[number]
        provider, raw_date, product, link, rev, imp, clk = [value.strip() for value in (row + [''] * 7)[:7]]
        if not product:
            raise ValueError('结算来源缺少产品名，无法确认数据归属')
        if _source_date(raw_date) != date:
            raise ValueError('结算来源读取期间日期发生变化，不能汇总不一致的数据')
        try:
            identity = (provider, date, product, link)
            if identity in identities:
                raise ValueError('结算来源出现重复产品、日期与链接记录')
            identities.add(identity)
            metrics = {'rev': _strict_metric(rev), 'imp': _strict_metric(imp, integer=True),
                       'clk': _strict_metric(clk, integer=True)}
            total = products.setdefault(product, {}).setdefault(date, {'rev': 0.0, 'imp': 0, 'clk': 0})
            for key, value in metrics.items():
                total[key] += value
                if not math.isfinite(total[key]) or (key != 'rev' and total[key] > 9007199254740991):
                    raise ValueError('结算汇总超出可确认范围')
        except (ValueError, TypeError, OverflowError):
            issues[product] = {'product': product, 'stage': '来源数据',
                               'error': '结算来源数值无效、读取期间数据变化或出现重复记录，已跳过该产品。'}
    for product in issues:
        products.pop(product, None)
    return products, issues, {'kind': 'settled_rows', 'basis': 'settled', 'effectiveFrom': from_date,
                             'rows': len(wanted), 'latestAvailableDate': max(seen_dates)}


def cmd_fetch_source(args):
    """Read every source row; isolate invalid data to the affected product."""
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    pivot_data, issues = {}, {}
    cmd = ['sheets', '+csv-get', '--spreadsheet-token', args.source_token, '--sheet-id', args.sheet_id, '--range', 'A1:E5000']
    res = run_feishu_cli(cmd)
    raw_csv = res.get('data', {}).get('annotated_csv', '')
    lines = [re.sub('^\\[row=\\d+\\]\\s*', '', line) for line in raw_csv.splitlines()]
    curr_prod = None
    for row in csv.reader(lines):
        if not row:
            continue
        p, d, rev, imp, clk = [value.strip() for value in (row + [''] * 5)[:5]]
        if p and not p.endswith('总计') and p not in ['产品', '行标签']:
            curr_prod = p
        if '总计' in p or '总计' in d or not d or d in ['日期', 'Date']:
            continue
        product = curr_prod or '未识别产品'
        try:
            if not curr_prod:
                raise ValueError('来源行缺少产品名')
            match = re.search(r'\d+[-/]\d+[-/]\d+', d)
            value = match.group(0) if match else d
            date = datetime.strptime(value.replace('/', '-'), '%Y-%m-%d').strftime('%Y-%m-%d')
            metrics = {'rev': _strict_metric(rev), 'imp': _strict_metric(imp, integer=True), 'clk': _strict_metric(clk, integer=True)}
            product_data = pivot_data.setdefault(curr_prod, {})
            if date in product_data:
                raise ValueError('同一产品和日期有重复来源数据')
            product_data[date] = metrics
        except (ValueError, TypeError, OverflowError):
            issues[product] = {'product': product, 'stage': '来源数据', 'error': '来源日期或数值无效，或同一日期存在重复数据，已跳过该产品。'}
    for product in issues:
        pivot_data.pop(product, None)
    source_info = {'kind': 'pivot'}
    if not pivot_data and not issues and DEFAULT_RAW_SHEET:
        pivot_data, issues, source_info = _settled_source(args)
    all_dates = sorted({date for dates in pivot_data.values() for date in dates})
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump({'updated_at': datetime.now().isoformat(), 'all_dates': all_dates, 'pivot_data': pivot_data, 'issues': list(issues.values()), 'source_info': source_info}, output, ensure_ascii=False, indent=2)
    print(f'Source products prepared: {len(pivot_data)}; products with issues: {len(issues)}')


def cmd_fetch_config(args):
    """Keep usable active targets and report invalid products after the run."""
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    res = run_feishu_cli(['base', '+record-list', '--base-token', args.base_token, '--table-id', args.table_id, '--as', 'bot', '--json'])
    inner = res.get('data', {})
    if inner.get('has_more'):
        raise ValueError('Incomplete config pagination')
    fields, rows = inner.get('fields', []), inner.get('data', [])
    record_ids = inner.get('record_id_list', [])
    bitable_configs, active_configs, active_names, issues = {}, {}, set(), {}
    for idx, row in enumerate(rows):
        rec = {name: row[i] if i < len(row) else None for i, name in enumerate(fields)}
        rec['_record_id'] = record_ids[idx] if idx < len(record_ids) else None
        name = rec.get('透视表产品名')
        state = rec.get('状态')
        enabled = state == '正常更新' or state == ['正常更新']
        if not name and not enabled:
            continue
        name = name or f'未命名配置（{rec["_record_id"] or idx + 1}）'
        if not enabled:
            bitable_configs.setdefault(name, rec)
            continue
        duplicate = name in active_names
        active_names.add(name)
        bitable_configs[name] = rec
        if duplicate:
            issues[name] = {'product': name, 'stage': '配置', 'error': '存在多条“正常更新”配置，已跳过该产品，请保留唯一启用记录。'}
        elif not rec.get('透视表产品名') or not rec.get('分表电子表格Token') or not rec.get('目标工作表ID'):
            issues[name] = {'product': name, 'stage': '配置', 'error': '启用配置缺少产品名、目标电子表格 Token 或工作表 ID，已跳过该产品。'}
        if name not in issues:
            active_configs[name] = rec
        else:
            active_configs.pop(name, None)
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump({'updated_at': datetime.now().isoformat(), 'total_records': len(bitable_configs), 'active_count': len(active_configs), 'requested_count': len(active_names), 'active_configs': active_configs, 'all_configs': bitable_configs, 'issues': list(issues.values())}, output, ensure_ascii=False, indent=2)
    print(f'Active targets prepared: {len(active_configs)}; products with config issues: {len(issues)}')

def cmd_scan(args):
    """扫描分表行号与预警"""
    with open(args.config_file, 'r', encoding='utf-8') as f:
        config_cache = json.load(f)
    active_configs = config_cache.get('active_configs', {})
    target_dates = [d.strip() for d in args.dates.split(',') if d.strip()]
    print(f'Scanning {len(active_configs)} active subsheets for dates: {target_dates}')
    date_regexes = {}
    for d in target_dates:
        parts = re.split('[-/]', d)
        if len(parts) == 3:
            (y, m, day) = (parts[0], int(parts[1]), int(parts[2]))
            pat = f'\\b{y}[-/]0?{m}[-/]0?{day}\\b'
        else:
            pat = re.escape(d)
        date_regexes[d] = re.compile(pat)

    def scan_item(item):
        (p, cfg) = item
        token = cfg['分表电子表格Token']
        sheet_id = cfg['目标工作表ID']
        col_range = cfg.get('更新列范围', 'D:F（收益/曝光/点击）')
        start_col = 'E' if 'E:G' in str(col_range) else 'D'
        cmd = ['sheets', '+csv-get', '--spreadsheet-token', token, '--sheet-id', sheet_id, '--range', 'A1:A750']
        try:
            res = run_feishu_cli(cmd)
            raw_csv = res.get('data', {}).get('annotated_csv', '')
            lines = raw_csv.splitlines()
            date_rows = {d: None for d in target_dates}
            _date_matches = {d: [] for d in target_dates}
            last_date_row = None
            last_date_str = None
            for l in lines:
                m = re.match('^\\[row=(\\d+)\\]\\s*(.*)', l)
                if not m:
                    continue
                r_num = int(m.group(1))
                val = m.group(2).strip()
                for (d, reg) in date_regexes.items():
                    if _scan_date(val) == d:
                        date_rows[d] = r_num
                        _date_matches[d].append(r_num)
                if '202' in val:
                    last_date_row = r_num
                    last_date_str = val
            missing = [d for (d, r) in date_rows.items() if r is None]
            _duplicates = [d for (d, matches) in _date_matches.items() if len(matches) > 1]
            return {'product': p, 'token': token, 'sheet_id': sheet_id, 'start_col': start_col, 'ok': True, 'date_rows': date_rows, 'is_complete': len(missing) == 0 and (not _duplicates), 'missing_dates': missing, 'last_date_row': last_date_row, 'last_date_str': last_date_str, 'duplicate_dates': _duplicates}
        except Exception as e:
            return {'product': p, 'token': token, 'sheet_id': sheet_id, 'ok': False, 'error': str(e)}
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(scan_item, it) for it in active_configs.items()]
        for f in concurrent.futures.as_completed(futures):
            results.append(f.result())
    complete = [r for r in results if r.get('ok') and r.get('is_complete')]
    expiring = [r for r in results if r.get('ok') and (not r.get('is_complete'))]
    failed = [r for r in results if not r.get('ok')]
    print(f'\nScan complete: Total={len(results)}, Complete={len(complete)}, Expiring/Missing={len(expiring)}, Failed={len(failed)}')
    if expiring:
        print('Expiring / Missing products:')
        for exp in expiring:
            print(f"  - {exp['product']}: missing {exp.get('missing_dates')}, last row={exp.get('last_date_row')} ({exp.get('last_date_str')})")
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump({'target_dates': target_dates, 'total_scanned': len(results), 'complete_count': len(complete), 'expiring_count': len(expiring), 'complete': complete, 'expiring': expiring, 'failed': failed}, f, ensure_ascii=False, indent=2)
    print(f'Scan results saved to: {args.output}')

def cmd_sync(args):
    """并发安全写入分表"""
    with open(args.source_file, 'r', encoding='utf-8') as f:
        source_data = json.load(f)['pivot_data']
    with open(args.scan_file, 'r', encoding='utf-8') as f:
        scan_data = json.load(f)
    dates = [d.strip() for d in args.dates.split(',') if d.strip()]
    to_sync_items = scan_data.get('complete', [])
    print(f'Starting sync for {len(to_sync_items)} products, dates: {dates}')
    tasks = []
    for item in to_sync_items:
        p = item['product']
        token = item['token']
        sheet_id = item['sheet_id']
        start_col = item.get('start_col', 'D')
        date_rows = item['date_rows']
        p_data = source_data[p]
        csv_lines = []
        min_row = min((date_rows[d] for d in dates))
        max_row = max((date_rows[d] for d in dates))
        for d in dates:
            d_val = p_data[d]
            csv_lines.append(f"{d_val['rev']},{d_val['imp']},{d_val['clk']}")
        csv_payload = '\n'.join(csv_lines)
        start_cell = f'{start_col}{min_row}'
        tasks.append({'product': p, 'token': token, 'sheet_id': sheet_id, 'start_cell': start_cell, 'read_range': f'A{min_row}:G{max_row}', 'csv_payload': csv_payload})
    if args.dry_run:
        print('DRY-RUN: tasks prepared; no write or message invoked')
        return

    def execute_item(task):
        result = {'product': task['product'], 'token': task['token'], 'sheet_id': task['sheet_id'], 'ok': False, 'step': 'put', 'written': False}
        try:
            run_feishu_cli(['sheets', '+csv-put', '--spreadsheet-token', task['token'], '--sheet-id', task['sheet_id'], '--start-cell', task['start_cell'], '--csv', task['csv_payload']])
            result.update(written=True, step='readback')
            # Compare stored values, never currency/percentage display strings.
            path = '/open-apis/sheets/v2/spreadsheets/' + task['token'] + '/values/' + quote(task['sheet_id'] + '!' + task['read_range'], safe='')
            reply = run_feishu_cli(['api', 'GET', path, '--params', json.dumps({'valueRenderOption': 'UnformattedValue', 'dateTimeRenderOption': 'FormattedString'})])
            value_range = reply.get('data', {}).get('valueRange', {})
            values = value_range.get('values')
            if not isinstance(values, list) or any(not isinstance(row, list) for row in values):
                raise RuntimeError('写入成功，但回读没有返回完整的原始单元格数据')
            remote_range = value_range.get('range')
            if remote_range is not None and remote_range != task['sheet_id'] + '!' + task['read_range']:
                raise RuntimeError('回读服务返回的区域与本轮目标不一致')
            start_row = int(re.search(r'([0-9]+):', task['read_range']).group(1))
            annotated = []
            for number, row in enumerate(values, start_row):
                output = io.StringIO(newline='')
                csv.writer(output, lineterminator='').writerow(row)
                annotated.append('[row=%s] %s' % (number, output.getvalue()))
            result.update(ok=True, readback='\n'.join(annotated), readback_values=values,
                          readback_range=task['read_range'], readback_render='UnformattedValue')
        except Exception as error:
            result['error'] = str(error)
        return result
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(execute_item, t) for t in tasks]
        for (idx, f) in enumerate(concurrent.futures.as_completed(futures), 1):
            results.append(f.result())
            if idx % 15 == 0 or idx == len(tasks):
                print(f'Progress: {idx}/{len(tasks)} synced...')
    successes = [r for r in results if r.get('ok')]
    failures = [r for r in results if not r.get('ok')]
    print(f'\nSync complete: Total={len(results)}, Success={len(successes)}, Failures={len(failures)}')
    if failures:
        print('Failures:')
        for fl in failures:
            print(f"  - {fl['product']}: {fl.get('error')}")
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump({'updated_at': datetime.now().isoformat(), 'dates': dates, 'total': len(results), 'success_count': len(successes), 'failure_count': len(failures), 'successes': successes, 'failures': failures}, f, ensure_ascii=False, indent=2)
    print(f'Sync execution results saved to: {args.output}')
import math

def _scan_date(value):
    cells = next(csv.reader([value]), [])
    if len(cells) != 1:
        return None
    raw = cells[0].strip()
    if not re.fullmatch(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", raw):
        return None
    try:
        return datetime.strptime(raw.replace('/', '-'), '%Y-%m-%d').strftime('%Y-%m-%d')
    except ValueError:
        return None

def _strict_metric(value, integer=False):
    text = str(value).strip().replace('$', '').replace(',', '')
    if not text:
        raise ValueError('Missing explicit source metric')
    number = float(text)
    if not math.isfinite(number) or (integer and (number < 0 or not number.is_integer())):
        raise ValueError('Invalid explicit source metric')
    return int(number) if integer else number

def run_feishu_cli(cmd_args, capture_json=True):
    operation = tuple(cmd_args[:2])
    metadata_read = (operation == ('api', 'GET') and len(cmd_args) == 3
                     and re.fullmatch(r'/open-apis/sheets/v3/spreadsheets/[A-Za-z0-9_-]+/sheets/query', cmd_args[2]))
    value_read = (operation == ('api', 'GET') and len(cmd_args) == 5 and cmd_args[3] == '--params'
                  and re.fullmatch(r'/open-apis/sheets/v2/spreadsheets/[A-Za-z0-9_-]+/values/[A-Za-z0-9_%!-]+', cmd_args[2]))
    if value_read:
        try:
            value_read = json.loads(cmd_args[4]) == {'valueRenderOption': 'UnformattedValue', 'dateTimeRenderOption': 'FormattedString'}
        except (ValueError, TypeError):
            value_read = False
    if not metadata_read and not value_read and operation not in {('sheets', '+csv-get'), ('base', '+record-list'), ('sheets', '+csv-put')}:
        raise RuntimeError('CLI operation is not permitted')
    if operation == ('sheets', '+csv-put') and os.environ.get('PARTNER_H5_ALLOW_WRITE') != '1':
        raise RuntimeError('Write is disabled for this invocation')
    if not FEISHU_SH:
        raise RuntimeError('Configured Feishu launcher is required')
    res = subprocess.run(['bash', FEISHU_SH, 'cli'] + cmd_args, capture_output=True, text=True)
    if res.returncode != 0 or not res.stdout:
        match = re.search(r'飞书表格操作未通过（(\d+)）', res.stderr or '')
        if match:
            raise RuntimeError(f'飞书错误码 {match.group(1)}：请检查该目标表格的访问或编辑权限。')
        raise RuntimeError('飞书表格调用失败，请检查该目标的权限和配置。')
    if not capture_json:
        return res.stdout
    try:
        payload = json.loads(res.stdout)
    except (ValueError, TypeError):
        raise RuntimeError('Feishu CLI returned invalid JSON') from None
    if not isinstance(payload, dict) or payload.get('ok') is False or payload.get('code') not in (None, 0):
        raise RuntimeError('Feishu CLI reported failure')
    if payload.get('code') == 0:
        payload['ok'] = True
    return payload

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Controlled online H5 synchronization; no expansion or messaging')
    sub = parser.add_subparsers(dest='command', required=True)
    src = sub.add_parser('fetch-source')
    src.add_argument('--output', required=True)
    src.add_argument('--dates')
    src.set_defaults(func=cmd_fetch_source, source_token=DEFAULT_SOURCE_TOKEN, sheet_id=DEFAULT_PIVOT_SHEET, local_excel=None)
    cfg = sub.add_parser('fetch-config')
    cfg.add_argument('--output', required=True)
    cfg.set_defaults(func=cmd_fetch_config, base_token=DEFAULT_BASE_TOKEN, table_id=DEFAULT_TABLE_ID)
    scan = sub.add_parser('scan')
    scan.add_argument('--dates', required=True)
    scan.add_argument('--config-file', required=True)
    scan.add_argument('--workers', type=int, default=4)
    scan.add_argument('--output', required=True)
    scan.set_defaults(func=cmd_scan)
    sync = sub.add_parser('sync')
    sync.add_argument('--source-file', required=True)
    sync.add_argument('--scan-file', required=True)
    sync.add_argument('--dates', required=True)
    sync.add_argument('--workers', type=int, default=4)
    sync.add_argument('--dry-run', action='store_true')
    sync.add_argument('--output', required=True)
    sync.set_defaults(func=cmd_sync)
    args = parser.parse_args()
    args.func(args)
if __name__ == '__main__':
    main()
