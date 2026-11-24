#!/usr/bin/env python3
"""Prepare an isolated Unity iOS test target, build/sign and install when connected.
Standard-library only. SDK/source integration itself is performed by the agent.
"""
import argparse
import base64
import datetime as dt
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

class DeliveryError(Exception):
    pass

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def run(args, *, env=None, timeout=60, logfile=None):
    try:
        if logfile:
            with logfile.open('w') as stream:
                p = subprocess.run(args, env=env, stdout=stream, stderr=subprocess.STDOUT,
                                   timeout=timeout, text=True)
            if p.returncode:
                raise DeliveryError(f'命令失败 ({p.returncode})，查看 {logfile}')
            return ''
        p = subprocess.run(args, env=env, capture_output=True, timeout=timeout, text=True)
    except subprocess.TimeoutExpired as exc:
        raise DeliveryError(f'命令超时 {timeout}s：{args[0]}；查看设备连接或日志后重试') from exc
    except FileNotFoundError as exc:
        raise DeliveryError(f'找不到工具：{args[0]}') from exc
    if p.returncode:
        raise DeliveryError(f'命令失败：{args[0]}\n{(p.stderr or p.stdout)[-3500:]}')
    return p.stdout

def load_config(path):
    c = json.loads(path.read_text())
    allowed = {'project_root', 'xcode_project', 'app_target', 'test_bundle_id', 'version', 'build_number',
               'output_dir', 'configuration', 'test_display_name', 'development_team', 'device_id',
               'developer_dir', 'allow_provisioning_updates', 'launch_after_install', 'production_bundle_id',
               'info_plist', 'dependency_projects'}
    unknown = set(c) - allowed
    if unknown:
        raise DeliveryError(f'构建参数含未知字段 {sorted(unknown)}；不要把SDK密钥/整个接入配置传入交付helper')
    required = ['project_root', 'xcode_project', 'app_target', 'test_bundle_id', 'version', 'build_number']
    for key in required:
        if not c.get(key) or str(c[key]).startswith('/path/'):
            raise DeliveryError(f'请填写参数 {key}')
    root = Path(c['project_root']).expanduser()
    if not root.is_absolute():
        root = path.parent / root
    root = root.resolve()
    project = (root / c['xcode_project']).resolve()
    if not (project / 'project.pbxproj').is_file():
        raise DeliveryError(f'未找到 Xcode 工程：{project}')
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', c['test_bundle_id']):
        raise DeliveryError('test_bundle_id 必须是独立有效 Bundle ID')
    if not re.fullmatch(r'\d+(?:\.\d+){0,2}', str(c['version'])):
        raise DeliveryError('version 使用数值版本，例如 1.0.2')
    if not re.fullmatch(r'\d+(?:\.\d+){0,2}', str(c['build_number'])):
        raise DeliveryError('build_number 使用数值构建号')
    c['project_root'] = str(root)
    c['xcode_project'] = str(project)
    output = Path(c.get('output_dir') or ('../' + root.name + '-sdk03-delivery')).expanduser()
    c['output_dir'] = str((root / output).resolve())
    if Path(c['output_dir']) == root:
        raise DeliveryError('output_dir 不能直接等于原工程目录')
    c.setdefault('configuration', 'Debug')
    c.setdefault('allow_provisioning_updates', True)
    c.setdefault('launch_after_install', True)
    c['version'] = str(c['version'])
    c['build_number'] = str(c['build_number'])
    return c

def developer_env(c):
    candidates = [c.get('developer_dir'), os.environ.get('DEVELOPER_DIR')]
    try:
        candidates.append(run(['/usr/bin/xcode-select', '-p']).strip())
    except DeliveryError:
        pass
    candidates.append('/Applications/Xcode.app/Contents/Developer')
    for value in candidates:
        if value and (Path(value) / 'usr/bin/xcodebuild').is_file():
            return dict(os.environ, DEVELOPER_DIR=value)
    raise DeliveryError('未找到完整 Xcode；请配置 developer_dir，不改全局 xcode-select')

def read_project(path):
    return json.loads(run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', str(path)]))

def prepare(c):
    root = Path(c['project_root'])
    output = Path(c['output_dir'])
    project = Path(c['xcode_project'])
    data = read_project(project / 'project.pbxproj')
    objects = data['objects']
    targets = [(key, value) for key, value in objects.items()
               if value.get('isa') == 'PBXNativeTarget' and value.get('name') == c['app_target']]
    if len(targets) != 1 or targets[0][1].get('productType') != 'com.apple.product-type.application':
        raise DeliveryError('app_target 必须唯一指向 App target；不要传 UnityFramework/Pods')
    target_id, target = targets[0]
    configs = [objects[i] for i in objects[target['buildConfigurationList']]['buildConfigurations']]
    selected = next((x for x in configs if x['name'] == c['configuration']), None)
    if selected is None:
        raise DeliveryError(f'不存在 configuration={c["configuration"]}')
    settings = selected['buildSettings']
    production_id = settings.get('PRODUCT_BUNDLE_IDENTIFIER')
    if not production_id or '$' in production_id:
        production_id = c.get('production_bundle_id')
    if not production_id:
        raise DeliveryError('正式包名不能解析；请填写 production_bundle_id')
    if production_id == c['test_bundle_id']:
        raise DeliveryError('测试包名不能与正式包名相同')
    # This helper deliberately supports the exported Unity app layout. Complex
    # generated plists/extensions require an agent to adapt the wrapper first.
    plist_value = c.get('info_plist') or settings.get('INFOPLIST_FILE')
    if not plist_value:
        raise DeliveryError('本 helper 需要实际 Info.plist，请在配置填写 info_plist')
    for token in ('$(SRCROOT)', '${SRCROOT}', '$(PROJECT_DIR)', '${PROJECT_DIR}'):
        plist_value = plist_value.replace(token, str(root))
    if '$' in plist_value:
        raise DeliveryError('Info.plist 路径包含未解析变量，请填写 info_plist')
    info_path = (root / plist_value).resolve()
    info = plistlib.loads(info_path.read_bytes())
    name = c.get('test_display_name') or (str(info.get('CFBundleDisplayName') or c['app_target']) + ' Test')
    name = re.sub(r'\$\{?\(?PRODUCT_NAME\)?\}?', c['app_target'], name)
    info.update(CFBundleIdentifier=c['test_bundle_id'], CFBundleDisplayName=name,
                CFBundleShortVersionString=c['version'], CFBundleVersion=c['build_number'])
    wrapper = output / 'TestProject'
    wrapper.mkdir(parents=True, exist_ok=True)
    test_project = wrapper / project.name
    test_project.mkdir(exist_ok=True)
    test_info = wrapper / 'Info-test.plist'
    test_info.write_bytes(plistlib.dumps(info))
    objects[data['rootObject']]['projectDirPath'] = str(root)
    for config in configs:
        b = config['buildSettings']
        b.update(PRODUCT_BUNDLE_IDENTIFIER=c['test_bundle_id'], INFOPLIST_FILE=str(test_info),
                 MARKETING_VERSION=c['version'], CURRENT_PROJECT_VERSION=c['build_number'],
                 CODE_SIGN_STYLE='Automatic', CODE_SIGNING_ALLOWED='YES',
                 PROVISIONING_PROFILE='', PROVISIONING_PROFILE_SPECIFIER='',
                 PROVISIONING_PROFILE_APP='', CODE_SIGN_IDENTITY='Apple Development')
        if c.get('development_team'):
            b['DEVELOPMENT_TEAM'] = c['development_team']
    (test_project / 'project.pbxproj').write_bytes(plistlib.dumps(data))
    # Absolute scheme reference is needed with a projectDirPath pointing to the
    # original root; the copied Unity scheme's relative reference may be unresolved.
    scheme_root = test_project / 'xcshareddata/xcschemes'
    scheme_root.mkdir(parents=True, exist_ok=True)
    scheme = ET.Element('Scheme', LastUpgradeVersion='2600', version='1.3')
    action = ET.SubElement(scheme, 'BuildAction', parallelizeBuildables='YES', buildImplicitDependencies='YES')
    entries = ET.SubElement(action, 'BuildActionEntries')
    entry = ET.SubElement(entries, 'BuildActionEntry', buildForTesting='NO', buildForRunning='YES',
                          buildForProfiling='NO', buildForArchiving='YES', buildForAnalyzing='YES')
    ET.SubElement(entry, 'BuildableReference', BuildableIdentifier='primary', BlueprintIdentifier=target_id,
                  BuildableName=c['app_target'] + '.app', BlueprintName=c['app_target'],
                  ReferencedContainer='container:' + str(test_project))
    ET.ElementTree(scheme).write(scheme_root / 'SDK03-Test.xcscheme', encoding='utf-8', xml_declaration=True)
    workspace = wrapper / 'SDK03-Test.xcworkspace'
    workspace.mkdir(exist_ok=True)
    ws = ET.Element('Workspace', version='1.0')
    ET.SubElement(ws, 'FileRef', location='absolute:' + str(test_project))
    dependencies = c.get('dependency_projects')
    if dependencies is None:
        dependencies = ['Pods/Pods.xcodeproj'] if (root / 'Pods/Pods.xcodeproj').exists() else []
    for value in dependencies:
        dependency = (root / value).resolve()
        if not dependency.is_dir():
            raise DeliveryError(f'缺少依赖工程：{dependency}；先完成原工程依赖安装')
        ET.SubElement(ws, 'FileRef', location='absolute:' + str(dependency))
    ET.ElementTree(ws).write(workspace / 'contents.xcworkspacedata', encoding='utf-8', xml_declaration=True)
    c['production_bundle_id'] = production_id
    c['test_display_name'] = name
    return workspace, settings.get('DEVELOPMENT_TEAM', '')

def emit_command(c):
    output = Path(c['output_dir'])
    output.mkdir(parents=True, exist_ok=True)
    dest = output / 'ios_test_delivery.py'
    if Path(__file__).resolve() != dest.resolve():
        shutil.copy2(__file__, dest)
    # Only build parameters are accepted here; SDK keys do not belong in this file.
    write_json(output / 'build-inputs.json', c)
    command = output / '一键安装测试包.command'
    command.write_text('''#!/bin/zsh
set -u
SDK03_SCRIPT_DIR="${0:A:h}"
/usr/bin/env python3 "$SDK03_SCRIPT_DIR/ios_test_delivery.py" --config "$SDK03_SCRIPT_DIR/build-inputs.json"
SDK03_RESULT=$?
if [[ -t 0 ]]; then
  printf '\\n执行结束（退出码 %s）。按 Return 关闭窗口。' "$SDK03_RESULT"
  read -r SDK03_REPLY
fi
exit "$SDK03_RESULT"
''')
    command.chmod(0o755)
    return command

def device_candidates(devices):
    result = []
    for device in devices:
        h = device.get('hardwareProperties', {})
        p = device.get('deviceProperties', {})
        connection = device.get('connectionProperties', {})
        if h.get('platform') != 'iOS' or h.get('reality') != 'physical':
            continue
        if connection.get('pairingState') == 'unpaired':
            continue
        # A wired device may have no DDI/tunnel yet. Cached, disconnected Wi-Fi
        # devices should not trigger a failed install in the no-device branch.
        if (connection.get('transportType') == 'wired' or connection.get('tunnelState') == 'connected'
                or p.get('ddiServicesAvailable') is True):
            result.append(device)
    return result

def select_device(devices, requested=None):
    if requested:
        matching = [d for d in devices if requested in
                    (d.get('identifier'), d.get('hardwareProperties', {}).get('udid'))]
        if len(matching) != 1:
            raise DeliveryError(f'指定设备未唯一找到：{requested}；检查连接/解锁/配对')
        return matching[0]
    candidates = device_candidates(devices)
    if len(candidates) > 1:
        choices = [(d.get('deviceProperties', {}).get('name'), d.get('identifier')) for d in candidates]
        raise DeliveryError(f'多个可用设备，请填写 device_id 后重试：{choices}')
    return candidates[0] if candidates else None

def signing_teams():
    identities = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'])
    valid = set(re.findall(r'\b[0-9A-F]{40}\b', identities))
    certs = run(['/usr/bin/security', 'find-certificate', '-a', '-p'], timeout=30)
    teams = set()
    for pem in re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', certs, re.S):
        der = base64.b64decode(''.join(pem.splitlines()[1:-1]))
        if hashlib.sha1(der).hexdigest().upper() not in valid:
            continue
        p = subprocess.run(['/usr/bin/openssl', 'x509', '-noout', '-subject', '-nameopt', 'RFC2253'],
                           input=pem, capture_output=True, text=True, timeout=10)
        if p.returncode:
            continue
        found = re.search(r'(?:^|,)OU=([A-Z0-9]+)(?:,|$)', p.stdout.strip().replace('subject=', ''))
        if found:
            teams.add(found.group(1))
    return teams

def choose_team(explicit, project_team, teams):
    if explicit:
        if explicit not in teams:
            raise DeliveryError(f'团队 {explicit} 没有本机有效签名身份；请在 Xcode 配置证书后重试')
        return explicit
    if project_team in teams:
        return project_team
    if len(teams) == 1:
        return next(iter(teams))
    raise DeliveryError('无法唯一选择签名团队，请填写 development_team（证书 OU / profile TeamIdentifier）')

def verify_profile(app, c, device):
    profile = app / 'embedded.mobileprovision'
    if not profile.exists():
        raise DeliveryError('签名包缺少 embedded.mobileprovision，不能真机安装')
    p = plistlib.loads(run(['/usr/bin/security', 'cms', '-D', '-i', str(profile)]).encode())
    expiration = p.get('ExpirationDate')
    if not expiration or expiration.replace(tzinfo=dt.timezone.utc) <= dt.datetime.now(dt.timezone.utc):
        raise DeliveryError('描述文件已过期')
    udid = device.get('hardwareProperties', {}).get('udid')
    if not p.get('ProvisionsAllDevices') and udid not in p.get('ProvisionedDevices', []):
        raise DeliveryError('描述文件未包含当前设备；请允许自动注册或提供正确 profile')
    expected = c['development_team'] + '.' + c['test_bundle_id']
    app_id = p.get('Entitlements', {}).get('application-identifier', '')
    if not fnmatch.fnmatchcase(expected, app_id):
        raise DeliveryError('描述文件的 Team/Bundle 与测试包不匹配')
    return {'team': p.get('TeamIdentifier'), 'expiration_utc': expiration.isoformat() + 'Z',
            'profile_name': p.get('Name'), 'device_included': True}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--prepare-only', action='store_true', help='仅产出测试工程和一键脚本，不构建/签名/操作设备')
    parser.add_argument('--plan', action='store_true', help='检查参数及复制的工程，无签名/构建/设备操作')
    parser.add_argument('--build-without-device', action='store_true', help='无可用设备时执行 generic iOS 免签构建')
    args = parser.parse_args(argv)
    c = load_config(args.config.expanduser().resolve())
    command = emit_command(c)  # Always deliver a retry entry, including failures.
    env = developer_env(c)
    workspace, project_team = prepare(c)
    emit_command(c)
    output = Path(c['output_dir'])
    run_id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    logs = output / 'logs' / run_id
    logs.mkdir(parents=True, exist_ok=True)
    report = {'run_id': run_id, 'test_bundle_id': c['test_bundle_id'], 'version': c['version'],
              'build_number': c['build_number'], 'command': str(command), 'state': 'prepared'}
    write_json(logs / 'report.json', report)
    print(f'测试工程已准备：{workspace}\n一键脚本：{command}', flush=True)
    if args.prepare_only or args.plan:
        print('仅准备模式：未构建、未签名、未安装、未启动设备。')
        return 0
    try:
        devices_path = logs / 'devices.json'
        run(['/usr/bin/xcrun', 'devicectl', 'list', 'devices', '--timeout', '30',
             '--json-output', str(devices_path)], env=env, timeout=40)
        devices = json.loads(devices_path.read_text()).get('result', {}).get('devices', [])
        device = select_device(devices, c.get('device_id'))
        cmd = ['/usr/bin/xcodebuild', '-workspace', str(workspace), '-scheme', 'SDK03-Test',
               '-configuration', c['configuration'], '-sdk', 'iphoneos',
               '-derivedDataPath', str(output / 'DerivedData')]
        if device:
            device_id = device['identifier']
            detail_path = logs / 'device-details.json'
            run(['/usr/bin/xcrun', 'devicectl', 'device', 'info', 'details', '--device', device_id,
                 '--timeout', '20', '--json-output', str(detail_path)], env=env, timeout=30)
            detailed = json.loads(detail_path.read_text()).get('result', {})
            # Device info details returns result.device on some Xcode versions.
            device = detailed.get('device', detailed) if 'hardwareProperties' in detailed or 'device' in detailed else device
            device.setdefault('identifier', device_id)
            if device.get('deviceProperties', {}).get('developerModeStatus') == 'disabled':
                raise DeliveryError('请先在 iPhone 启用开发者模式、解锁并信任此电脑')
            c['development_team'] = choose_team(c.get('development_team'), project_team, signing_teams())
            cmd += ['-destination', 'id=' + device.get('hardwareProperties', {}).get('udid', device_id),
                    'DEVELOPMENT_TEAM=' + c['development_team']]
            if c['allow_provisioning_updates']:
                cmd += ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration']
        elif args.build_without_device:
            cmd += ['-destination', 'generic/platform=iOS', 'CODE_SIGNING_ALLOWED=NO']
        else:
            report['state'] = 'no_device_command_ready'
            print('当前无可用连接设备；已产出 .command。以后连接手机后双击，将重新签名构建并安装。')
            return 0
        print('开始构建；日志：' + str(logs / 'xcodebuild.log'), flush=True)
        run(cmd + ['build'], env=env, timeout=2400, logfile=logs / 'xcodebuild.log')
        products = output / 'DerivedData/Build/Products' / (c['configuration'] + '-iphoneos')
        matches = []
        for app in products.glob('*.app'):
            info = plistlib.loads((app / 'Info.plist').read_bytes())
            if info.get('CFBundleIdentifier') == c['test_bundle_id']:
                matches.append((app, info))
        if len(matches) != 1:
            raise DeliveryError('未唯一找到目标测试 .app，检查构建产物')
        app, info = matches[0]
        if info.get('CFBundleShortVersionString') != c['version'] or info.get('CFBundleVersion') != c['build_number']:
            raise DeliveryError('最终包版本与参数不一致')
        report['app'] = str(app)
        if not device:
            report['state'] = 'unsigned_build_command_ready'
            print('免签构建通过；该 .app 尚不可安装。连接设备后双击 .command 重新签名安装。')
            return 0
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], timeout=120)
        report['profile'] = verify_profile(app, c, device)
        report['device_id'] = device_id
        report['state'] = 'signed_build'
        run(['/usr/bin/xcrun', 'devicectl', 'device', 'install', 'app', '--device', device_id,
             str(app), '--timeout', '180', '--json-output', str(logs / 'install.json')], env=env, timeout=190,
            logfile=logs / 'install.log')
        apps_path = logs / 'installed-apps.json'
        run(['/usr/bin/xcrun', 'devicectl', 'device', 'info', 'apps', '--device', device_id,
             '--timeout', '30', '--json-output', str(apps_path)], env=env, timeout=40)
        installed = json.loads(apps_path.read_text()).get('result', {}).get('apps', [])
        if not any(x.get('bundleIdentifier') == c['test_bundle_id'] and x.get('version') == c['version']
                   and x.get('bundleVersion') == c['build_number'] for x in installed):
            raise DeliveryError('安装命令已完成，但设备应用清单未确认本次包/版本')
        report['state'] = 'installed'
        if c['launch_after_install']:
            run(['/usr/bin/xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device_id,
                 '--terminate-existing', '--environment-variables', json.dumps({'SDK03_RUN_ID': run_id}),
                 c['test_bundle_id'], '--timeout', '30', '--json-output', str(logs / 'launch.json')],
                env=env, timeout=40, logfile=logs / 'launch.log')
            report['state'] = 'installed_launched'
        print('测试包已安装' + ('并启动' if c['launch_after_install'] else '') + '。仍需本次运行日志和画面/听感验收。')
        print('描述文件到期（UTC）：' + report['profile']['expiration_utc'])
        return 0
    except Exception as exc:
        report['error'] = str(exc)
        report['state_before_error'] = report['state']
        report['state'] = 'failed'
        raise
    finally:
        write_json(logs / 'report.json', report)
        emit_command(c)

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (DeliveryError, ValueError, OSError, KeyError) as exc:
        print('SDK03：' + str(exc), file=sys.stderr)
        print('如为 PLA 协议/信任/开发者模式问题，先在账号或手机上完成该动作，再双击一键脚本重试。', file=sys.stderr)
        sys.exit(1)
