"""Validate the explicit date selection shared by consumption workflow steps."""
import re
import sys
from datetime import date, timedelta


def normalize_dates(value):
    if not isinstance(value, str):
        raise ValueError('dates 必须是逗号分隔的日期字符串。')
    dates = [day.strip() for day in value.split(',')]
    if not 1 <= len(dates) <= 31 or any(not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) for day in dates):
        raise ValueError('日期须为合法 YYYY-MM-DD，最多31天，不可留空。')
    try:
        days = [date.fromisoformat(day) for day in dates]
    except ValueError:
        raise ValueError('请选择有效的更新日期。') from None
    if any(current - previous != timedelta(days=1) for previous, current in zip(days, days[1:])):
        raise ValueError('日期必须唯一、升序且逐日连续，不自动扩展日期。')
    return dates


def parse_dates(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if '--dates' not in argv:
        return None
    index = argv.index('--dates')
    if argv.count('--dates') != 1 or index + 1 == len(argv):
        raise ValueError('请通过 --dates 指定一次更新日期。')
    return normalize_dates(argv[index + 1])


def date_serial(day):
    return (date.fromisoformat(day) - date(1899, 12, 30)).days
