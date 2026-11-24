#!/usr/bin/env python3
"""Integrate a supported Unity export, then install a test app or deliver a script.

Default: render -> preflight -> apply -> device-aware delivery -> local build if
no signed test build completed. --plan-only writes preparation reports only.
--script-only still integrates and validates, but never probes or installs devices.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
import delivery as device_delivery
PATH_KEYS = {
    'project': ['path'],
    'sdk': ['xcframework', 'privacy_manifest'],
    'adjust': ['sdk_xcframework', 'signature_xcframework', 'privacy_manifest', 'signature_privacy_manifest'],
    'xcode': ['developer_dir'],
}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    path.chmod(0o600)


def normalized_config(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('Parameters must be a JSON object.')
    for section, keys in PATH_KEYS.items():
        part = data.get(section, {})
        if not isinstance(part, dict):
            raise ValueError(section + ' must be an object.')
        for key in keys:
            value = part.get(key)
            if value:
                p = Path(value).expanduser()
                part[key] = str((path.parent / p).resolve() if not p.is_absolute() else p.resolve())
    test = data.setdefault('test', {})
    if not isinstance(test, dict):
        raise ValueError('test must be an object.')
    if 'bundle_id' not in test and isinstance(data.get('app', {}).get('bundle_id'), str):
        test['bundle_id'] = data['app']['bundle_id'] + '.sdktest'
    return data


def protected_metadata(project, target_name):
    # The integrator writes a validated XML project. Include every explicit
    # main-App plist, not only project metadata, when validating custom builds.
    pbx = project / 'project.pbxproj'
    model = plistlib.loads(pbx.read_bytes())
    objects = model['objects']
    target = next(v for v in objects.values() if v.get('isa') == 'PBXNativeTarget' and v.get('name') == target_name)
    root = objects[model['rootObject']]
    source = (project.parent / root.get('projectDirPath', '')).resolve()
    paths = [pbx]
    project_configs = {objects[key]['name']: objects[key].get('buildSettings', {})
                       for key in objects[root['buildConfigurationList']]['buildConfigurations']}
    for key in objects[target['buildConfigurationList']]['buildConfigurations']:
        config = objects[key]
        effective = {**project_configs.get(config['name'], {}), **config.get('buildSettings', {})}
        value = effective['INFOPLIST_FILE'].strip(chr(34))
        for variable in ('SRCROOT', 'SOURCE_ROOT', 'PROJECT_DIR'):
            value = value.replace('$(' + variable + ')', str(source)).replace('${' + variable + '}', str(source))
        if '$' in value:
            raise ValueError('Unsupported Info.plist path variable during validation.')
        info = Path(value)
        paths.append(info if info.is_absolute() else source / info)
    return sorted(set(paths))


def command(argv, log, env=None, timeout=1800):
    print('执行：' + Path(argv[1] if argv[0] == sys.executable else argv[0]).name + '；日志：' + str(log), flush=True)
    start = time.monotonic()
    with log.open('w', encoding='utf-8') as handle:
        process = subprocess.Popen(argv, env=env, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        while True:
            try:
                return process.wait(timeout=min(20, max(1, timeout - (time.monotonic() - start))))
            except subprocess.TimeoutExpired:
                if time.monotonic() - start >= timeout:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=10)
                    raise TimeoutError('Command timed out; see ' + str(log))
                print('仍在执行，已用时 %ds；%s' % (time.monotonic() - start, log), flush=True)


def pipeline(args, config, run):
    params = run / 'parameters.json'
    write_json(params, config)
    report = {'run_id': run.name, 'project': config.get('project', {}).get('path'),
              'source_applied': False, 'installed': False, 'launched': False,
              'evidence': {}, 'status': 'preparing'}
    status_file = run / 'pipeline-status.json'
    try:
        # Pure validation only: no device detection, build, or delivery output.
        # Invalid test identity must fail before formal source is changed.
        device_delivery.load_config(params)
        host = run / 'GeneratedHost'
        rendered = command([sys.executable, str(HERE / 'render_host_sources.py'), '--config', str(params),
                            '--output', str(host), '--include-launch-storyboards'], run / 'render.log', timeout=60)
        if rendered:
            raise ValueError('Host parameter validation/render failed; see render.log.')
        base = [sys.executable, str(HERE / 'integrate_xcode.py'), '--config', str(params),
                '--generated-host', str(host), '--output-report', str(run / 'preflight.json')]
        checked = command(base + ['--check-only'], run / 'preflight.log', timeout=180)
        if checked:
            report['status'] = 'blocked_preflight'
            report['message'] = 'Unsupported inputs or existing project require agent review; see preflight.json/log. No integration applied.'
            return report, 2
        report['evidence']['preflight'] = str(run / 'preflight.json')
        if args.plan_only:
            report.update(status='plan_ready', message='Generated host and preflight ready; project, devices and builds untouched.')
            return report, 0
        base[-1] = str(run / 'integration-report.json')
        if command(base, run / 'integration.log', timeout=180):
            raise ValueError('Integration failed; inspect integration report and rollback backup.')
        report['source_applied'] = True
        report['evidence']['integration'] = str(run / 'integration-report.json')
        source = Path(config['project']['path'])
        protected = protected_metadata(source, config['project'].get('target', 'Unity-iPhone'))
        # Build validation is separate from integration; custom source scripts may
        # have side effects. Report unexpected project metadata changes.
        metadata_before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
        install_dir = run / 'TestInstall'
        delivery = [sys.executable, str(HERE / 'delivery.py'), '--config', str(params), '--output-dir', str(install_dir)]
        if args.script_only:
            delivery.append('--script-only')
        delivery_code = command(delivery, run / 'delivery.log', timeout=2400)
        result_path = install_dir / 'status.json'
        result = json.loads(result_path.read_text()) if result_path.is_file() else {'status': 'failed', 'message': 'Delivery did not write status.json.'}
        report['delivery'] = result
        report['installed'] = result.get('installed', False)
        report['launched'] = result.get('launched', False)
        report['script'] = result.get('script', str(install_dir / '安装iOS测试包.command'))
        if result.get('status') == 'installed_and_launched':
            report['evidence']['signed_test_build'] = result.get('log_dir')
            report.update(status='installed_and_launched', message='Development test app installed/launched; SDK page and backend still need runtime evidence.')
        else:
            # A script is always useful when there is no usable device. Validate
            # code without a signing dependency when the local toolchain permits.
            developer = config.get('xcode', {}).get('developer_dir', '/Applications/Xcode.app/Contents/Developer')
            env = dict(os.environ, DEVELOPER_DIR=developer)
            build_log = run / 'unsigned-arm64-build.log'
            argv = ['/usr/bin/xcodebuild', '-project', str(source), '-scheme', config['project'].get('scheme', 'Unity-iPhone'),
                    '-configuration', 'Debug', '-destination', 'generic/platform=iOS',
                    '-derivedDataPath', str(run / 'UnsignedDerivedData'),
                    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'COMPILER_INDEX_STORE_ENABLE=NO', 'build']
            try:
                build_code = command(argv, build_log, env=env, timeout=1800)
                report['evidence']['unsigned_arm64_build'] = {'passed': build_code == 0, 'log': str(build_log)}
            except (OSError, TimeoutError) as error:
                build_code = 1
                report['evidence']['unsigned_arm64_build'] = {'passed': False, 'log': str(build_log), 'error': str(error)}
            report.update(status='script_ready' if not build_code and delivery_code in (0, 2) else 'validation_blocked',
                          message='Self-contained install folder is available; see delivery reason and build evidence. No successful phone install is implied.')
        changed = [str(p) for p in protected if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != metadata_before[str(p)]]
        if changed:
            report.update(status='source_changed_during_validation', changed_metadata=changed)
        return report, 0 if report['status'] in ('installed_and_launched', 'script_ready') else 2
    except (OSError, ValueError, TypeError, KeyError, TimeoutError, device_delivery.DeliveryError) as error:
        report.update(status='failed', message=str(error))
        return report, 1
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        write_json(status_file, report)
        print('流程结果：' + str(status_file), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--plan-only', action='store_true', help='Generate host and read-only preflight; never change project/build/device.')
    mode.add_argument('--script-only', action='store_true', help='Integrate and validate locally; generate script without device operations.')
    args = parser.parse_args()
    try:
        config = normalized_config(args.config.expanduser().resolve())
        output = args.output_dir.expanduser().absolute()
        if output.is_symlink():
            raise ValueError('Output must not be a symlink.')
        output = output.resolve()
        source = Path(config['project']['path']).resolve().parent
        if output == source or output.is_relative_to(source) or source.is_relative_to(output):
            raise ValueError('Output directory must be outside the source directory and must not contain it.')
        output.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(str(output / '.pipeline.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock_fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            run = output / 'runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:6])
            run.mkdir(parents=True)
            report, code = pipeline(args, config, run)
            write_json(output / 'latest.json', {'run': str(run), **report})
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
            return code
    except BlockingIOError:
        print('Another pipeline is using this output directory.', file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, KeyError) as error:
        print('error: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
