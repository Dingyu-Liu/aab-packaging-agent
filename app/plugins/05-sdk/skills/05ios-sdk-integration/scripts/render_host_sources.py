#!/usr/bin/env python3
"""Render the reviewed Unity host template into a separate output directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sys
import tempfile
from urllib.parse import urlparse

SKILL_ROOT = Path(__file__).resolve().parents[1]


def fail(message):
    raise ValueError(message)


def token(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9]{1,128}', value):
        fail(name + ' must be a real alphanumeric token, not a placeholder.')
    return value


def validated_config(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        fail('Configuration must be a JSON object.')
    try:
        sdk, adjust, app, ui = data['sdk'], data['adjust'], data['app'], data['ui']
        data = {
            'app_store_id': sdk['app_store_id'],
            'expected_config_endpoint': sdk['expected_config_endpoint'],
            'tracking_usage_description': app['tracking_usage_description'],
            'adjust_app_token': adjust['app_token'],
            'adjust_environment': adjust['environment'],
            'pa_start_mode': sdk['start_mode'],
            'adjust_event_tokens': adjust['event_tokens'],
            'startup_loading': ui['startup_loading'],
            'safe_area': ui['safe_area'],
            'initial_page_timeout_seconds': ui.get('initial_page_timeout_seconds', 60),
        }
    except (KeyError, TypeError) as error:
        fail('Missing or invalid section/key in integration config: ' + str(error))
    for field in ('startup_loading', 'safe_area'):
        if type(data[field]) is not bool:
            fail(field + ' must be true or false.')
    timeout = data['initial_page_timeout_seconds']
    if type(timeout) not in (int, float) or not 5 <= timeout <= 300:
        fail('initial_page_timeout_seconds must be a finite number from 5 to 300.')
    app_id = data['app_store_id']
    if not isinstance(app_id, str) or not re.fullmatch(r'[0-9]{6,20}', app_id):
        fail('app_store_id must be the numeric App Store ID as a string.')
    endpoint = data['expected_config_endpoint']
    if not isinstance(endpoint, str):
        fail('expected_config_endpoint must be a URL string.')
    parsed = urlparse(endpoint)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
        fail('expected_config_endpoint must be an HTTP(S) URL without credentials.')
    if parsed.hostname == 'example.com' or parsed.hostname.endswith('.example.com'):
        fail('Replace the example endpoint with the SDK endpoint confirmed for this task.')
    description = data['tracking_usage_description']
    if not isinstance(description, str) or not description.strip() or any(word in description for word in ('请按本次', '请填写', '示例不能')):
        fail('Provide the actual app-specific ATT usage description.')
    token(data['adjust_app_token'], 'adjust_app_token')
    if data['adjust_environment'] not in ('production', 'sandbox'):
        fail('adjust_environment must be production or sandbox.')
    mode = data['pa_start_mode']
    if type(mode) is not int or not 0 <= mode <= 2147483647:
        fail('pa_start_mode must be an integer verified against the supplied SDK.')
    events = data['adjust_event_tokens']
    if not isinstance(events, dict) or not events or len(events) > 100:
        fail('adjust_event_tokens must be a non-empty event-name-to-token dictionary.')
    for event, value in events.items():
        if not isinstance(event, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', event):
            fail('Invalid event name: ' + repr(event))
        token(value, 'event token for ' + event)
    return data


def render(config_path, output, launch_screens):
    data = validated_config(config_path)
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        fail('Output must be absent or an empty directory; existing work will not be overwritten.')
    assets = SKILL_ROOT / 'assets'
    template = assets / 'unity-host'
    if not template.is_dir():
        fail('Missing assets/unity-host next to this script.')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.pakit-host-', dir=str(output.parent)))
    try:
        replacements = {
            '__ADJUST_APP_TOKEN__': data['adjust_app_token'],
            '__ADJUST_ENVIRONMENT__': ('ADJEnvironmentProduction' if data['adjust_environment'] == 'production' else 'ADJEnvironmentSandbox'),
            '__ADJUST_EVENT_MAP__': '\n'.join(
                '        @' + json.dumps(event) + ': @' + json.dumps(value) + ','
                for event, value in data['adjust_event_tokens'].items()
            ),
            '__PAKIT_START_MODE__': str(data['pa_start_mode']),
        }
        for source in sorted(template.rglob('*')):
            if source.is_file():
                destination = temporary / source.relative_to(template)
                destination.parent.mkdir(parents=True, exist_ok=True)
                text = source.read_text(encoding='utf-8')
                for key, value in replacements.items():
                    text = text.replace(key, value)
                if re.search(r'__(ADJUST|PAKIT)_[A-Z_]+__', text):
                    fail('Unresolved template parameter in ' + source.name)
                destination.write_text(text, encoding='utf-8')
        if launch_screens and data['startup_loading']:
            for source in (assets / 'launch-screen').glob('*.storyboard'):
                shutil.copy2(source, temporary / source.name)
        fragment = {
            'PAKitIntegrationEnabled': True,
            'PAKitAppStoreID': data['app_store_id'],
            'PAKitExpectedConfigEndpoint': data['expected_config_endpoint'],
            'NSUserTrackingUsageDescription': data['tracking_usage_description'],
            'PAKitStartupLoadingEnabled': data['startup_loading'],
            'PAKitSafeAreaEnabled': data['safe_area'],
            'PAKitInitialPageTimeoutSeconds': data['initial_page_timeout_seconds'],
        }
        (temporary / 'Info.plist.fragment').write_bytes(plistlib.dumps(fragment, sort_keys=False))
        manifest = {
            'template': '05ios-sdk-integration/unity-host',
            'compatibility_origin': 'Unity 6000.0.77f1, iOS 17.2+, PA API + Adjust v5',
            'loading_behavior': 'navigation-complete reveal; no snapshot gate or SDK background override',
            'adjust_environment': data['adjust_environment'],
            'pa_start_mode': data['pa_start_mode'],
            'startup_loading': data['startup_loading'],
            'safe_area': data['safe_area'],
            'files': {str(p.relative_to(temporary)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(temporary.rglob('*')) if p.is_file()},
        }
        (temporary / 'INTEGRATION-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        if output.exists():
            output.rmdir()  # Only the explicitly allowed empty directory.
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    print('Generated host files: ' + str(output))
    print('Merge Info.plist.fragment and add source files to the correct target; the project was not edited.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--include-launch-storyboards', action='store_true')
    args = parser.parse_args()
    try:
        render(args.config.expanduser().absolute(), args.output.expanduser().absolute(), args.include_launch_storyboards)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print('error: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
