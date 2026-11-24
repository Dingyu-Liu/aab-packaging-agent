#!/usr/bin/env python3
"""Portable 01 test installer. Operates on a generated copy of the delivered Xcode project."""
from __future__ import annotations
import argparse
import datetime
import fnmatch
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

ACTIVE = None
REPORT = {}
RESULT = None
LOG = None

class NeedsUser(Exception): pass
class NoDevice(Exception): pass
class NeedsRepair(Exception): pass

def save():
    if RESULT:
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        temporary = RESULT.with_suffix('.tmp')
        temporary.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(RESULT)

def stop_child():
    global ACTIVE
    if ACTIVE and ACTIVE.poll() is None:
        try: os.killpg(ACTIVE.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: ACTIVE.wait(timeout=.6)
        except subprocess.TimeoutExpired:
            try: os.killpg(ACTIVE.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            ACTIVE.wait(timeout=.5)

def cancelled(signum, _frame):
    stop_child()
    REPORT.update(status='cancelled', error='已停止本次安装流程；若请求已经发送，手机实际状态需重新核对。')
    save()
    raise SystemExit(130)

def command(args, stage, timeout=60, private=False):
    global ACTIVE
    REPORT['stage'] = stage
    if not private: print({'detect-device':'正在检查连接设备…','verify-device-connection':'正在确认设备可达性…','build-test-app':'正在构建和签名测试包…','install-test-app':'正在安装测试包…'}.get(stage, stage), flush=True)
    save()
    env = dict(os.environ)
    developer = Path('/Applications/Xcode.app/Contents/Developer')
    if not env.get('DEVELOPER_DIR') and developer.is_dir(): env['DEVELOPER_DIR'] = str(developer)
    ACTIVE = subprocess.Popen([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    try: out, err = ACTIVE.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop_child()
        out, err = ACTIVE.communicate()
        if LOG and not private:
            with LOG.open('ab') as stream: stream.write(out + b'\n' + err + b'\n')
        REPORT.update(status='needs_user', timedOutStage=stage)
        save()
        raise NeedsUser('阶段 %s 超时；请查看本次日志后重试。' % stage)
    result = ACTIVE.returncode
    ACTIVE = None
    if LOG and not private:
        with LOG.open('ab') as stream: stream.write(out + b'\n' + err + b'\n')
    return result, out, err

def load_plist(path):
    try: return plistlib.loads(Path(path).read_bytes())
    except plistlib.InvalidFileException:
        code, output, _ = command(['/usr/bin/plutil', '-convert', 'xml1', '-o', '-', path], 'read-xcode-project')
        if code: raise NeedsUser('无法读取 Xcode 工程配置。')
        return plistlib.loads(output)

def read_devices(preferred=None, non_interactive=True):
    with tempfile.TemporaryDirectory(prefix='partner-device-') as temporary:
        output = Path(temporary) / 'devices.json'
        code, _, _ = command(['/usr/bin/xcrun', 'devicectl', 'list', 'devices', '--json-output', output, '--timeout', '10'], 'detect-device', 15)
        if code or not output.exists(): raise NeedsUser('无法列出设备，请确认 Xcode 已完成首次启动并安装设备支持组件。')
        devices = json.loads(output.read_text()).get('result', {}).get('devices', [])
        candidates = []
        blocked_wired = False
        for device in devices:
            connection = device.get('connectionProperties', {})
            hardware = device.get('hardwareProperties', {})
            kind = str(hardware.get('deviceType', hardware.get('platform', ''))).lower()
            if kind and not any(name in kind for name in ['iphone', 'ipad', 'ios']): continue
            if connection.get('pairingState') != 'paired': continue
            identifier = device.get('identifier')
            if preferred and preferred not in [identifier, hardware.get('udid'), device.get('deviceProperties', {}).get('name')]: continue
            if not identifier: continue
            details = Path(temporary) / (str(uuid.uuid4()) + '.json')
            code, _, _ = command(['/usr/bin/xcrun', 'devicectl', 'device', 'info', 'details', '--device', identifier, '--json-output', details, '--timeout', '8'], 'verify-device-connection', 12)
            if code or not details.exists():
                blocked_wired |= connection.get('transportType') in ['wired', 'usb']
                continue
            current = json.loads(details.read_text()).get('result', {})
            current = current.get('device', current)
            props = current.get('deviceProperties', device.get('deviceProperties', {}))
            if props.get('developerModeStatus') == 'disabled': raise NeedsUser('手机尚未开启开发者模式，请开启后解锁、信任此电脑再重试。')
            candidates.append({'id': identifier, 'udid': current.get('hardwareProperties', hardware).get('udid', hardware.get('udid')), 'name': props.get('name', device.get('deviceProperties', {}).get('name', 'iPhone'))})
        if not candidates:
            if preferred or blocked_wired: raise NeedsUser('指定手机或有线设备当前不可访问，请解锁手机、信任此电脑并检查开发者模式。')
            raise NoDevice('未发现本次可连接的 iPhone/iPad；工程和安装脚本已交付，连接设备后重新运行此脚本。')
        if len(candidates) > 1:
            if non_interactive: raise NeedsUser('发现多台可用设备，请通过 --device 指定安装目标。')
            for i, item in enumerate(candidates): print('%s. %s' % (i + 1, item['name']))
            try: return candidates[int(input('选择安装设备序号：')) - 1]
            except (ValueError, IndexError): raise NeedsUser('设备选择无效。')
        return candidates[0]

def logged_xcode_teams():
    code, output, _ = command(['/usr/bin/defaults', 'export', 'com.apple.dt.Xcode', '-'], 'read-xcode-team-metadata', private=True)
    if code: return set()
    try: data = plistlib.loads(output)
    except plistlib.InvalidFileException: return set()
    found = set()
    def visit(value, key=''):
        if isinstance(value, dict):
            for name, item in value.items(): visit(item, str(name).lower())
        elif isinstance(value, list):
            for item in value: visit(item, key)
        elif isinstance(value, str) and 'team' in key and re.fullmatch(r'[A-Z0-9]{10}', value): found.add(value)
    visit(data)
    return found

def development_teams():
    code, identities, _ = command(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], 'check-development-identities', private=True)
    hashes = set(re.findall(rb'\b[A-Fa-f0-9]{40}\b', identities)) if code == 0 else set()
    code, certificates, _ = command(['/usr/bin/security', 'find-certificate', '-a', '-p'], 'read-development-certificates', private=True)
    teams = set()
    if code: return teams
    for pem in re.findall(rb'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----', certificates):
        try:
            der = ssl.PEM_cert_to_DER_cert(pem.decode())
            if hashlib.sha1(der).hexdigest().upper().encode() not in {value.upper() for value in hashes}: continue
            with tempfile.NamedTemporaryFile(suffix='.pem') as handle:
                handle.write(pem); handle.flush(); details = ssl._ssl._test_decode_cert(handle.name)
            subject = {key: value for group in details.get('subject', []) for key, value in group}
            if subject.get('commonName', '').startswith(('Apple Development:', 'iPhone Developer:')) and subject.get('organizationalUnitName'): teams.add(subject['organizationalUnitName'])
        except (ValueError, OSError, ssl.SSLError): continue
    return teams

def choose_team(config, explicit):
    if explicit:
        if not re.fullmatch(r'[A-Z0-9]{10}', explicit): raise NeedsUser('Team ID 格式无效。')
        return explicit
    teams = development_teams()
    logged = logged_xcode_teams()
    if logged: teams &= logged
    preferred = config.get('preferredDevelopmentTeam')
    if preferred in teams: return preferred
    if len(teams) == 1: return next(iter(teams))
    if not teams: raise NeedsUser('没有可用的 Apple Development 签名身份。请在 Xcode 登录开发者账号并创建开发证书，或使用 --team 指定已配置的团队。')
    raise NeedsUser('发现多个开发签名团队，请使用 --team 指定本次测试团队。')

def prepare_test_project(source, destination, config):
    destination.parent.mkdir(parents=True, exist_ok=True)
    root = source.resolve()
    def ignored(directory, names):
        values = {name for name in names if name in ['.git', 'xcuserdata', '.DS_Store']}
        if Path(directory).resolve() == root: values.update(name for name in names if name in ['build', 'DerivedData'])
        return values
    shutil.copytree(source, destination, symlinks=True, ignore=ignored)
    pbx = destination / config['projectFile'] / 'project.pbxproj'
    if destination.resolve() not in pbx.resolve().parents: raise NeedsUser('Xcode 工程文件指向测试副本外，已停止修改。')
    data = load_plist(pbx)
    objects = data.get('objects', {})
    targets = [obj for obj in objects.values() if obj.get('isa') == 'PBXNativeTarget' and obj.get('productType') == 'com.apple.product-type.application' and obj.get('name') == config['applicationTarget']]
    if len(targets) != 1: raise NeedsUser('未能唯一确定测试 App target，请检查交付配置。')
    configs = objects[targets[0]['buildConfigurationList']]['buildConfigurations']
    for identifier in configs:
        settings = objects[identifier].setdefault('buildSettings', {})
        settings['PRODUCT_BUNDLE_IDENTIFIER'] = config['testBundleIdentifier']
        settings['CODE_SIGN_STYLE'] = 'Automatic'
        settings['CODE_SIGNING_ALLOWED'] = 'YES'
        settings['CODE_SIGN_IDENTITY'] = 'Apple Development'
        settings['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = 'Apple Development'
        if config.get('testBuildNumber'): settings['CURRENT_PROJECT_VERSION'] = config['testBuildNumber']
        for key in list(settings):
            if key.startswith('PROVISIONING_PROFILE'): settings.pop(key, None)
        plist = settings.get('INFOPLIST_FILE')
        if isinstance(plist, str):
            for token in ['$(SRCROOT)/', '${SRCROOT}/', '$(PROJECT_DIR)/', '${PROJECT_DIR}/']: plist = plist.replace(token, '')
            path = (destination / plist).resolve()
            if destination.resolve() not in path.parents: raise NeedsUser('App Info.plist 引用了工程外的路径，请修复导出工程。')
            if path.is_file():
                info = load_plist(path)
                info['CFBundleIdentifier'] = '$(PRODUCT_BUNDLE_IDENTIFIER)'
                if config.get('testBuildNumber'): info['CFBundleVersion'] = '$(CURRENT_PROJECT_VERSION)'
                with path.open('wb') as handle: plistlib.dump(info, handle, sort_keys=False)
    with pbx.open('wb') as handle: plistlib.dump(data, handle, sort_keys=False)
    return destination

def validate_app(app, bundle, team, udid):
    info = load_plist(app / 'Info.plist')
    REPORT['appBuildNumber'] = str(info.get('CFBundleVersion', ''))
    if REPORT.get('testBuildNumber') and REPORT['appBuildNumber'] != REPORT['testBuildNumber']: raise NeedsRepair('本次 App 构建号与测试构建号不一致。')
    if info.get('CFBundleIdentifier') != bundle: raise NeedsUser('本次构建 App 的 Bundle ID 与测试包名不一致，已停止安装。')
    code, _, _ = command(['/usr/bin/codesign', '--verify', '--deep', '--strict', app], 'verify-code-signature')
    if code: raise NeedsUser('本次 App 签名校验失败，已停止安装。')
    code, output, _ = command(['/usr/bin/codesign', '-d', '--entitlements', ':-', app], 'verify-entitlements', private=True)
    if code: raise NeedsUser('无法读取测试 App 签名权限。')
    entitlements = plistlib.loads(output)
    if entitlements.get('com.apple.developer.team-identifier') != team: raise NeedsUser('测试 App 签名团队与所选团队不一致。')
    profile = app / 'embedded.mobileprovision'
    if not profile.is_file(): raise NeedsUser('App 缺少设备开发描述文件。')
    code, output, _ = command(['/usr/bin/security', 'cms', '-D', '-i', profile], 'verify-provisioning-profile', private=True)
    if code: raise NeedsUser('无法解析设备描述文件。')
    decoded = plistlib.loads(output)
    if decoded.get('ExpirationDate', datetime.datetime.min) <= datetime.datetime.utcnow(): raise NeedsUser('设备描述文件已过期。')
    if team not in decoded.get('TeamIdentifier', []): raise NeedsUser('描述文件团队与实际签名不一致。')
    app_id = decoded.get('Entitlements', {}).get('application-identifier', '')
    signed_app_id = entitlements.get('application-identifier', '')
    if not signed_app_id.endswith('.' + bundle) or not fnmatch.fnmatchcase(signed_app_id, app_id): raise NeedsUser('描述文件未包含本次测试包名。')
    certificate_prefix = app.parent / 'partner-signing-certificate-'
    code, _, _ = command(['/usr/bin/codesign', '-d', '--extract-certificates', certificate_prefix, app], 'verify-signing-certificate', private=True)
    leaf = Path(str(certificate_prefix) + '0')
    if code or not leaf.is_file() or leaf.read_bytes() not in decoded.get('DeveloperCertificates', []): raise NeedsUser('App 签名证书未包含在描述文件中。')
    if udid not in decoded.get('ProvisionedDevices', []): raise NeedsUser('当前设备未包含在开发描述文件中。')
    code, sdk_output, _ = command(['/usr/bin/xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], 'read-ios-sdk')
    sdk = Path(sdk_output.decode().strip()) if code == 0 else None
    executables = [app / info.get('CFBundleExecutable', '')]
    for framework in (app / 'Frameworks').glob('*.framework'):
        executable = framework / framework.stem
        if executable.is_file(): executables.append(executable)
    for executable in executables:
        code, output, _ = command(['/usr/bin/otool', '-l', executable], 'verify-native-dependencies')
        if code: raise NeedsUser('无法检查 App 原生动态依赖。')
        for block in re.split(rb'Load command \d+', output):
            if not re.search(rb'\bcmd LC_LOAD_DYLIB\b', block): continue
            match = re.search(rb'\bname ([^\r\n]+?) \(offset', block)
            if not match: continue
            dependency = match[1].decode().strip()
            if dependency.startswith(('/System/Library/', '/usr/lib/')): continue
            if dependency.startswith('@rpath/'):
                suffix = dependency[len('@rpath/'):]
                exists = any((base / suffix).exists() for base in [app / 'Frameworks', executable.parent / 'Frameworks'])
                if not exists and sdk and re.fullmatch(r'libswift[A-Za-z0-9_]+\.dylib', suffix) and b'/usr/lib/swift' in output:
                    minimum = tuple(int(x) for x in str(info.get('MinimumOSVersion', '0')).split('.')[:2])
                    threshold = (15, 0) if suffix == 'libswift_Concurrency.dylib' else (16, 0) if suffix in ['libswift_RegexParser.dylib','libswift_StringProcessing.dylib'] else (12, 2)
                    exists = minimum >= threshold and (sdk / 'usr/lib/swift' / suffix.replace('.dylib', '.tbd')).is_file()
            elif dependency.startswith('@loader_path/'): exists = (executable.parent / dependency[len('@loader_path/'):]).exists()
            elif dependency.startswith('@executable_path/'): exists = (app / dependency[len('@executable_path/'):]).exists()
            else: exists = False
            if not exists: raise NeedsRepair('强动态依赖未随 App 嵌入：' + dependency)
    REPORT['signatureVerified'] = True
    REPORT['nativeDependenciesVerified'] = True
    REPORT['mainExecutableSha256'] = hashlib.sha256((app / info['CFBundleExecutable']).read_bytes()).hexdigest()

def main(argv=None):
    global RESULT, LOG, REPORT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('delivery-config.json'))
    parser.add_argument('--project', type=Path)
    parser.add_argument('--device')
    parser.add_argument('--team', default=os.environ.get('PARTNER_AGENT_TEST_TEAM'))
    parser.add_argument('--non-interactive', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--json-result', type=Path)
    parser.add_argument('--run-id')
    args = parser.parse_args(argv)
    if args.run_id and not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args.run_id): parser.error('invalid run ID')
    os.umask(0o077)
    identifier = args.run_id or str(uuid.uuid4())
    base = args.config.resolve().parent
    lock = (base / '.installation.lock').open('a')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close(); print('本交付目录已有安装脚本在运行，请等待结束。'); return 3
    RESULT = args.json_result or base / 'installation-result.json'
    LOG = base / ('install-' + identifier + '.log')
    REPORT = {'schemaVersion': 1, 'runId': identifier, 'status': 'starting', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'built': False, 'installed': False, 'launched': False, 'logPath': str(LOG)}
    for sig in [signal.SIGINT, signal.SIGTERM]: signal.signal(sig, cancelled)
    save()
    try:
        config = json.loads(args.config.read_text())
        sequence = base / '.test-build-number.json'
        try: last = int(json.loads(sequence.read_text())['counter'])
        except (OSError, ValueError, KeyError): last = 0
        now = datetime.datetime.utcnow()
        counter = max(int(now.strftime('%y%m')) * 10000 + now.day * 100 + now.hour, last + 1)
        if counter >= 100000000: raise NeedsUser('测试构建号超出范围，请指定新的测试包名。')
        config['testBuildNumber'] = '%s.%s.%s' % (counter // 10000, (counter // 100) % 100, counter % 100)
        sequence.write_text(json.dumps({'counter': counter}))
        REPORT['testBuildNumber'] = config['testBuildNumber']
        bundle = config['testBundleIdentifier']
        if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', bundle) or bundle == config['productionBundleIdentifier']: raise NeedsUser('必须使用与正式应用不同的有效测试 Bundle ID。')
        REPORT.update(testBundleIdentifier=bundle, productionBundleIdentifier=config['productionBundleIdentifier'])
        device = None if args.prepare_only else read_devices(args.device, args.non_interactive)
        if device: REPORT['device'] = device
        source = args.project.resolve() if args.project else base / 'Xcode工程'
        if not source.is_dir():
            archive = base / '最终Xcode工程.zip'
            if not archive.is_file(): raise NeedsUser('请将最终Xcode工程.zip 与安装脚本放在同一目录。')
            digest = hashlib.sha256()
            with archive.open('rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''): digest.update(chunk)
            if digest.hexdigest() != config.get('xcodeArchiveSha256'): raise NeedsUser('Xcode 工程压缩包校验未通过，请重新下载本次交付包。')
            code, _, _ = command(['/usr/bin/ditto', '-xk', archive, base], 'extract-xcode-project', 600)
            if code or not source.is_dir(): raise NeedsUser('Xcode 工程解压失败。')
        team = None if args.prepare_only else choose_team(config, args.team or config.get('explicitDevelopmentTeam'))
        if team: REPORT['developmentTeam'] = team
        build_root = base / '.test-build' / identifier
        project = prepare_test_project(source, build_root / 'Xcode工程', config)
        REPORT['testXcodeProject'] = str(project)
        if args.prepare_only:
            REPORT.update(status='prepared', stage='prepared'); save(); return 0
        container = project / config.get('workspaceFile', config['projectFile'])
        flag = '-workspace' if container.suffix == '.xcworkspace' else '-project'
        derived = build_root / 'DerivedData'
        build = ['/usr/bin/xcrun', 'xcodebuild', flag, container, '-scheme', config['scheme'], '-configuration', config.get('configuration', 'Debug'), '-sdk', 'iphoneos', '-destination', 'id=' + (device['udid'] or device['id']), '-derivedDataPath', derived, '-allowProvisioningUpdates', 'DEVELOPMENT_TEAM=' + team, 'CODE_SIGN_STYLE=Automatic', 'build']
        code, output, errors = command(build, 'build-test-app', 1800)
        if code:
            evidence = (output + errors).decode(errors='replace')[-20000:]
            if re.search(r'No profiles|requires a development team|No signing certificate|CodeSign|keychain|User interaction|credentials|authentication|provisioning|account', evidence, re.I):
                raise NeedsUser('测试包签名未完成。请查看日志并在 Xcode/系统中完成账号、证书或钥匙串授权后重试。')
            raise NeedsRepair('实际 Xcode 测试包编译或链接失败，请根据本次日志修复 Unity 源工程和可重现的导出流程。')
        apps = list((derived / 'Build' / 'Products' / (config.get('configuration', 'Debug') + '-iphoneos')).glob('*.app'))
        if len(apps) != 1: raise NeedsUser('未能唯一找到本次新构建的测试 App，未使用旧包安装。')
        app = apps[0]
        validate_app(app, bundle, team, device['udid'])
        REPORT.update(built=True, appPath=str(app))
        save()
        installed = build_root / 'install.json'
        REPORT['installationRequestedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(); save()
        code, _, _ = command(['/usr/bin/xcrun', 'devicectl', 'device', 'install', 'app', '--device', device['id'], '--json-output', installed, '--timeout', '120', app], 'install-test-app', 130)
        if code or not installed.is_file(): raise NeedsUser('测试 App 已构建，但安装未完成。请解锁、信任此电脑并检查开发者模式；已保留 App 与日志。')
        result = json.loads(installed.read_text()).get('result', {})
        installed_apps = result.get('installedApplications', [])
        if not any(item.get('bundleID', item.get('bundleIdentifier')) == bundle for item in installed_apps): raise NeedsUser('安装命令结束，但结构化结果未确认测试包名；请查看安装报告。')
        REPORT.update(installed=True, status='installed', stage='installed', installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        print('测试包已安装：' + bundle)
        print('安装结果不代表已验证启动画面或后台收数；可以在手机上打开测试。')
        save(); return 0
    except NoDevice as error:
        REPORT.update(status='no_device', error=str(error)); print(str(error)); save(); return 2
    except NeedsRepair as error:
        REPORT.update(status='repair_required', error=str(error)); print(str(error)); save(); return 4
    except (NeedsUser, OSError, ValueError, KeyError, plistlib.InvalidFileException) as error:
        REPORT.update(status='needs_user', error=str(error)); print(str(error)); save(); return 3
    finally:
        stop_child(); lock.close()

if __name__ == '__main__': raise SystemExit(main())
