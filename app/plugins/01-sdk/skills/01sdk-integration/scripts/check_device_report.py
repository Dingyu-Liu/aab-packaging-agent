#!/usr/bin/env python3
"""Validate fresh full-screen bridge-test evidence without copying device IDs or keys."""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import re

DEFAULT_ORIENTATIONS = ('portrait', 'landscape-left', 'landscape-right')
NATIVE_NAMES = {'portrait': 'Portrait', 'landscape-left': 'LandscapeLeft', 'landscape-right': 'LandscapeRight'}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('An ISO timestamp with a timezone is required')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamps must include a timezone')
    return parsed.timestamp()


def positive(value):
    return not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and value > 0


def orientation_valid(item):
    if not isinstance(item, dict) or item.get('passed') is not True:
        return False
    name = item.get('requested')
    viewport, css = item.get('viewport') or {}, item.get('javascriptViewport') or {}
    if not isinstance(viewport, dict) or not isinstance(css, dict):
        return False
    if name not in NATIVE_NAMES or viewport.get('orientation') != NATIVE_NAMES[name]:
        return False
    w, h = viewport.get('width'), viewport.get('height')
    safe, frame = viewport.get('safeArea') or {}, viewport.get('webViewFrame') or {}
    if not isinstance(safe, dict) or not isinstance(frame, dict):
        return False
    sw, sh = safe.get('width'), safe.get('height')
    cw, ch, scale = css.get('innerWidth'), css.get('innerHeight'), css.get('devicePixelRatio')
    if not all(positive(v) for v in [w, h, sw, sh, cw, ch, scale]) or sw > w or sh > h:
        return False
    if not all(isinstance(frame.get(k), (int, float)) and not isinstance(frame.get(k), bool)
               and math.isfinite(frame.get(k)) for k in ['x', 'y', 'width', 'height']):
        return False
    if any(abs(actual - expected) > 1 for actual, expected in
           [(frame['x'], 0), (frame['y'], 0), (frame['width'], w), (frame['height'], h)]):
        return False
    portrait = name == 'portrait'
    if (portrait and not (h > w and ch > cw)) or (not portrait and not (w > h and cw > ch)):
        return False
    return sw / scale - 2 <= cw <= w / scale + 2 and sh / scale - 2 <= ch <= h / scale + 2


def http_code(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599 else None


def summarize_report(report, not_before, expected_cases=16, orientations=None, clock_skew_seconds=3):
    cutoff = timestamp(not_before)
    if expected_cases < 1 or not math.isfinite(clock_skew_seconds) or not 0 <= clock_skew_seconds <= 30:
        raise ValueError('Expected cases must be positive; clock skew must be between 0 and 30 seconds')
    orientations = tuple(DEFAULT_ORIENTATIONS if orientations is None else orientations)
    if not orientations or len(set(orientations)) != len(orientations) or any(o not in NATIVE_NAMES for o in orientations):
        raise ValueError('Specify distinct supported orientation names')
    issues = []
    try:
        start, end = timestamp(report.get('startedAtUtc')), timestamp(report.get('finishedAtUtc'))
        fresh = start >= cutoff - clock_skew_seconds and end >= start
    except (ValueError, TypeError):
        fresh = False
    if not fresh:
        issues.append('stale_or_invalid_run_timestamps')
    web = report.get('webReport') or {}
    if not isinstance(web, dict): web = {}
    cases = web.get('cases') or []
    if not isinstance(cases, list): cases = []
    names = [c.get('name') for c in cases if isinstance(c, dict)]
    web_ok = (web.get('passed') is True and len(cases) == expected_cases and
              all(isinstance(n, str) and n for n in names) and len(set(names)) == expected_cases and
              all(isinstance(c, dict) and c.get('passed') is True for c in cases))
    if not web_ok:
        issues.append('web_case_evidence_incomplete_or_failed')
    rows = report.get('orientations') or []
    if not isinstance(rows, list): rows = []
    selected = [row for row in rows if isinstance(row, dict) and row.get('requested') in orientations]
    rotation_ok = (len(selected) == len(orientations) and
                   {row.get('requested') for row in selected} == set(orientations) and
                   all(orientation_valid(row) for row in selected))
    if not rotation_ok:
        issues.append('orientation_or_viewport_evidence_incomplete_or_failed')
    complete = report.get('phase') == 'complete' and report.get('outcome') == 'passed' and report.get('cleanupCompleted') is True
    if not complete:
        issues.append('run_not_completed_successfully')
    diagnostics = report.get('diagnostics') or {}
    if not isinstance(diagnostics, dict): diagnostics = {}
    state = report.get('runtimeStatus') or report.get('initialRuntimeStatus') or {}
    if not isinstance(state, dict): state = {}
    entry_error = state.get('entryError')
    if not isinstance(entry_error, str) or not re.fullmatch(r'[a-z0-9_]{0,80}', entry_error):
        entry_error = '[unavailable or non-code detail redacted]'
    return {'fresh': fresh, 'test_run_passed': fresh and web_ok and rotation_ok and complete,
            'web_bridge_passed': fresh and web_ok, 'orientations_passed': fresh and rotation_ok,
            'passed_web_cases': sum(isinstance(c, dict) and c.get('passed') is True for c in cases),
            'expected_web_cases': expected_cases, 'expected_orientations': list(orientations),
            'issues': issues, 'entry_error': entry_error,
            'sdk': {'evidence_from_current_run': fresh, 'appsflyer_initialized': diagnostics.get('appsFlyerInitialized') is True,
                    'facebook_initialized': diagnostics.get('facebookInitialized') is True,
                    'appsflyer_session_http': http_code(diagnostics.get('afLastSessionResponseCode')),
                    'appsflyer_event_http': http_code(diagnostics.get('afLastEventResponseCode'))},
            'vendor_dashboard_verified': False, 'entry_contract_verified': False,
            'evidence_scope': 'Local on-device bridge/viewport report and last SDK HTTP statuses; not an independent backend or dashboard audit.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--not-before', required=True, help='UTC/offset timestamp recorded immediately before the new launch')
    parser.add_argument('--expected-cases', type=int, default=16)
    parser.add_argument('--orientations', nargs='+', choices=tuple(NATIVE_NAMES), default=list(DEFAULT_ORIENTATIONS))
    parser.add_argument('--clock-skew-seconds', type=float, default=3)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        data = json.loads(args.report.read_text())
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON report object')
        result = summarize_report(data, args.not_before, args.expected_cases, args.orientations, args.clock_skew_seconds)
    except (ValueError, TypeError, OSError) as error:
        parser.error(str(error))
    text = json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    else:
        print(text, end='')
    return 0 if result['test_run_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
