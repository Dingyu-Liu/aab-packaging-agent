#!/usr/bin/env python3
"""Render PA/Adjust host sources into a new scratch directory, never into a project by default."""
import argparse
import json
from pathlib import Path
import re
import sys
from project_inputs import load_inputs


def java_string(value):
    return json.dumps(value, ensure_ascii=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compatible-api-confirmed', action='store_true',
                        help='Required for versions other than the tested PA1.0.3 / Adjust5.8.0 API shape')
    args = parser.parse_args()
    try:
        config = load_inputs(args.config, require_host=True)
        target = args.output.expanduser().absolute()
        project = Path(config['project_dir']).resolve()
        resolved = target.resolve()
        if target.exists() or resolved == project or project in resolved.parents or resolved in project.parents:
            raise ValueError('Use a new scratch output outside the source project; existing paths are not overwritten')
        base = config['host']['base_activity']
        # These are the only parent APIs represented by this template. Others need an explicit merge.
        if base not in ('com.unity3d.player.UnityPlayerGameActivity',
                        'com.unity3d.player.UnityPlayerActivity', 'android.app.Activity'):
            raise ValueError('Unsupported template Activity parent; merge the PA flow into the actual host manually')
        pa = config['pa']
        adjust = config['adjust']
        known = (pa['maven_coordinate'] == 'com.pakit.05:ammo:1.0.3' and
                 (not adjust['enabled'] or adjust['maven_coordinate'] == 'com.adjust.sdk:adjust-android:5.8.0'))
        if not known and not args.compatible_api_confirmed:
            raise ValueError('Inspect the resolved PA/Adjust API first, then pass --compatible-api-confirmed if compatible')
        package = config['host']['package_name']
        replacements = {
            'PACKAGE': package,
            'BASE_ACTIVITY': base,
            'BASE_ACTIVITY_SIMPLE': base.rsplit('.', 1)[1],
            'PA_COORDINATE': java_string(pa['maven_coordinate']),
            'PA_MODE': str(pa['mode']),
            'PA_ATT': str(pa['att']),
        }
        if adjust['enabled']:
            cases = '\n'.join('            case {}: return {};' .format(java_string(name), java_string(token))
                              for name, token in adjust['event_tokens'].items())
            replacements.update({
                'APP_TOKEN': java_string(adjust['app_token']),
                'ADJUST_ENV': adjust['environment'].upper(),
                'ADJUST_ENV_STRING': java_string(adjust['environment']),
                'EVENT_CASES': cases,
            })
        templates = Path(__file__).resolve().parent.parent / 'assets/host'
        rendered = {}
        for name in ['GpSdkActivity.java', 'GpSdkApplication.java', 'GpAdjustTracker.java']:
            if name == 'GpAdjustTracker.java' and not adjust['enabled']:
                text = ('package ' + package + ';\n\nimport android.app.Application;\nimport android.util.Log;\n\n'
                        'final class GpAdjustTracker {\n'
                        '    private GpAdjustTracker() {}\n'
                        '    static void initialize(Application application) {}\n'
                        '    static void onPaEvent(String eventName, String paramsJson) {\n'
                        '        Log.i("GpPaSdk", "PA event received: " + eventName);\n'
                        '    }\n}\n')
            else:
                text = (templates / (name + '.tpl')).read_text(encoding='utf-8')
                text = re.sub(r'@@([A-Z_]+)@@', lambda match: replacements[match.group(1)], text)
            if re.search(r'@@[A-Z_]+@@', text):
                raise ValueError('Unresolved template marker')
            rendered[name] = text
        java_root = target / Path(*package.split('.'))
        java_root.mkdir(parents=True, exist_ok=False)
        for name, text in rendered.items():
            p = java_root / name
            p.write_text(text, encoding='utf-8')
            p.chmod(0o600)
        print(json.dumps({'status': 'rendered', 'output': str(target), 'files': sorted(rendered),
                          'next': 'Review and merge into the actual host, dependencies and Manifest; no project was modified.'},
                         ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as error:
        if isinstance(error, json.JSONDecodeError):
            print('Invalid JSON at line {}, column {}'.format(error.lineno, error.colno), file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
