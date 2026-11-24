#!/usr/bin/env python3
"""Compatibility commands backed by this App's local OAuth connection.

Only an ephemeral local bridge key enters child processes. User access and
refresh tokens stay in the Node service. Uses Python 3.8+ standard library.
"""
import csv
import io
import json
import os
import re
import sys
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import ProxyHandler, Request, build_opener


def api(method, path, query=None, body=None):
    url = os.environ.get('PARTNER_FEISHU_BRIDGE_URL', '')
    parsed = urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.path != '/api/feishu/bridge':
        raise ValueError('Missing a valid local Feishu connection')
    key = os.environ.get('PARTNER_FEISHU_BRIDGE_KEY', '')
    if not key:
        raise ValueError('Missing local Feishu bridge credentials')
    request = Request(url, data=json.dumps({'method': method, 'path': path, 'query': query or {}, **({'body': body} if body is not None else {})}, ensure_ascii=False).encode(), headers={'Content-Type': 'application/json', 'X-Partner-Agent': 'local', 'Authorization': 'Bearer ' + key}, method='POST')
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=45) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.loads(error.read()).get('error', 'Feishu request failed')
        except (ValueError, TypeError):
            message = 'Feishu request failed'
        raise RuntimeError(message) from None


def options(args):
    values = {}
    index = 0
    while index < len(args):
        key = args[index]
        if not key.startswith('--'):
            raise ValueError('Invalid Feishu option')
        if key == '--json' and (index + 1 == len(args) or args[index + 1].startswith('--')):
            values.setdefault(key, []).append(True)
            index += 1
        else:
            if index + 1 >= len(args):
                raise ValueError('Missing Feishu option value')
            values.setdefault(key, []).append(args[index + 1])
            index += 2
    return values


def required(opts, key):
    value = opts.get(key, [''])[-1]
    if not isinstance(value, str) or not value:
        raise ValueError('Missing ' + key)
    return value


def identifier(opts, key):
    value = required(opts, key)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Invalid resource identifier')
    return value


def pages(path, query=None):
    token = None
    seen = set()
    for _ in range(1000):
        response = api('GET', path, {**(query or {}), 'page_size': 100, **({'page_token': token} if token else {})})
        data = response.get('data', {})
        items = data.get('items', [])
        if not isinstance(items, list):
            raise ValueError('Invalid Feishu pagination response')
        yield from items
        if not data.get('has_more'):
            return
        token = data.get('page_token')
        if not isinstance(token, str) or not token or token in seen:
            raise ValueError('Incomplete Feishu pagination')
        seen.add(token)
    raise ValueError('Feishu pagination limit exceeded')


def field_value(value):
    if isinstance(value, list) and all(isinstance(cell, dict) and 'text' in cell for cell in value):
        return ''.join(str(cell['text']) for cell in value)
    if isinstance(value, dict) and ('link' in value or 'text' in value):
        return value.get('link') or value.get('text') or ''
    return value


def csv_text(value):
    value = field_value(value)
    if value is None:
        return ''
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def column(index):
    result = ''
    while index:
        index, mod = divmod(index - 1, 26)
        result = chr(65 + mod) + result
    return result


def execute(args):
    if len(args) < 2:
        raise ValueError('Missing Feishu command')
    group, operation = args[:2]
    if group == 'api':
        if len(args) < 3 or operation not in ('GET', 'PUT', 'POST'):
            raise ValueError('Unsupported Feishu API method')
        opts = options(args[3:])
        return api(operation, args[2], json.loads(opts.get('--params', ['{}'])[-1]), json.loads(opts['--data'][-1]) if '--data' in opts else None)
    opts = options(args[2:])
    if group == 'sheets':
        token, sheet = identifier(opts, '--spreadsheet-token'), identifier(opts, '--sheet-id')
        prefix = '/open-apis/sheets/v2/spreadsheets/' + token
        if operation == '+csv-get':
            cell_range = required(opts, '--range')
            match = re.fullmatch(r'[A-Z]+([1-9][0-9]*):[A-Z]+[1-9][0-9]*', cell_range)
            if not match:
                raise ValueError('Invalid sheet read range')
            data = api('GET', prefix + '/values/' + quote(sheet + '!' + cell_range, safe=''), {'valueRenderOption': 'FormattedValue', 'dateTimeRenderOption': 'FormattedString'})
            rows = data.get('data', {}).get('valueRange', {}).get('values')
            if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
                raise ValueError('Missing sheet values')
            annotated = []
            for number, row in enumerate(rows, int(match.group(1))):
                output = io.StringIO(newline='')
                csv.writer(output, lineterminator='\n').writerow([csv_text(value) for value in row])
                annotated.append('[row=%s] %s' % (number, output.getvalue().rstrip('\n')))
            return {'ok': True, 'data': {'annotated_csv': '\n'.join(annotated)}}
        if operation == '+csv-put':
            start = required(opts, '--start-cell')
            match = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', start)
            if not match:
                raise ValueError('Invalid sheet write cell')
            rows = list(csv.reader(io.StringIO(required(opts, '--csv'))))
            if not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows):
                raise ValueError('Sheet write data is empty or not rectangular')
            values = [[float(value) if re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', value) else value for value in row] for row in rows]
            start_col = 0
            for letter in match.group(1):
                start_col = start_col * 26 + ord(letter) - 64
            end = column(start_col + len(rows[0]) - 1) + str(int(match.group(2)) + len(rows) - 1)
            return api('PUT', prefix + '/values', body={'valueRange': {'range': sheet + '!' + start + ':' + end, 'values': values}})
    if group == 'base':
        base, table = identifier(opts, '--base-token'), identifier(opts, '--table-id')
        prefix = '/open-apis/bitable/v1/apps/' + base + '/tables/' + table
        if operation == '+record-list':
            fields = list(pages(prefix + '/fields'))
            selected = opts.get('--field-id')
            if selected:
                fields = [field for field in fields if field['field_name'] in selected or field['field_id'] in selected]
            names = [field['field_name'] for field in fields]
            query = {'field_names': json.dumps(names, ensure_ascii=False)} if selected else {}
            offset = int(opts.get('--offset', ['0'])[-1])
            limit = int(opts['--limit'][-1]) if '--limit' in opts else None
            if offset < 0 or (limit is not None and limit <= 0):
                raise ValueError('Invalid record offset or limit')
            records = []
            has_more = False
            for index, record in enumerate(pages(prefix + '/records', query)):
                if index < offset:
                    continue
                if limit is not None and len(records) >= limit:
                    has_more = True
                    break
                records.append(record)
            return {'ok': True, 'data': {'fields': names, 'field_type_list': [{3: 'select', 5: 'datetime'}.get(field['type'], '') for field in fields], 'record_id_list': [record['record_id'] for record in records], 'data': [[field_value(record['fields'].get(name)) for name in names] for record in records], 'has_more': has_more}}
        if operation == '+record-upsert':
            fields = json.loads(required(opts, '--json'))
            if not isinstance(fields, dict):
                raise ValueError('Invalid record fields')
            for name, value in list(fields.items()):
                if (name.endswith('时间') or name in {'日期', '数据日', '预估口径起始日', '生效起始日', '更新时间'}) and isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:[ T].*)?', value):
                    fields[name] = int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
            if '--record-id' in opts:
                return api('PUT', prefix + '/records/' + identifier(opts, '--record-id'), body={'fields': fields})
            return api('POST', prefix + '/records', body={'fields': fields})
    raise ValueError('This Feishu connection supports spreadsheet and Base updates only')


if __name__ == '__main__':
    try:
        print(json.dumps(execute(sys.argv[1:]), ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
