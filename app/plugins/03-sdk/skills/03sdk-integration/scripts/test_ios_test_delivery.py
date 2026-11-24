#!/usr/bin/env python3
"""Safe helper checks. Fixtures/mocks only: no signing, build or device mutation."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('ios_test_delivery.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def device(identifier='phone', *, transport='wired', tunnel='disconnected', ddi=False):
    return {'identifier': identifier,
            'hardwareProperties': {'platform': 'iOS', 'reality': 'physical', 'udid': identifier + '-udid'},
            'deviceProperties': {'name': identifier, 'ddiServicesAvailable': ddi, 'developerModeStatus': 'enabled'},
            'connectionProperties': {'pairingState': 'paired', 'transportType': transport, 'tunnelState': tunnel}}


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='sdk03 test $ ')
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        export = self.root / 'source with space'
        export.mkdir()
        project = export / 'Unity-iPhone.xcodeproj'
        project.mkdir()
        data = {'rootObject': 'root', 'objects': {
            'root': {'isa': 'PBXProject', 'projectDirPath': ''},
            'app': {'isa': 'PBXNativeTarget', 'name': 'Unity-iPhone',
                    'productType': 'com.apple.product-type.application', 'buildConfigurationList': 'app-list'},
            'framework': {'isa': 'PBXNativeTarget', 'name': 'UnityFramework',
                          'productType': 'com.apple.product-type.framework', 'buildConfigurationList': 'framework-list'},
            'app-list': {'buildConfigurations': ['debug']},
            'framework-list': {'buildConfigurations': ['framework-debug']},
            'debug': {'name': 'Debug', 'buildSettings': {'PRODUCT_BUNDLE_IDENTIFIER': 'com.example.game',
                      'INFOPLIST_FILE': 'Info.plist', 'DEVELOPMENT_TEAM': 'COMPANY123'}},
            'framework-debug': {'name': 'Debug', 'buildSettings': {'PRODUCT_BUNDLE_IDENTIFIER': 'com.unity3d.framework'}}}}
        self.project_file = project / 'project.pbxproj'
        self.project_file.write_bytes(plistlib.dumps(data))
        (export / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleDisplayName': 'My Game',
             'CFBundleIdentifier': '${PRODUCT_BUNDLE_IDENTIFIER}', 'CFBundleShortVersionString': '1.0.0',
             'CFBundleVersion': '1'}))
        self.before = self.project_file.read_bytes(), (export / 'Info.plist').read_bytes()
        self.config_file = self.root / 'build.json'
        self.config = {'project_root': str(export), 'xcode_project': project.name, 'app_target': 'Unity-iPhone',
                       'test_bundle_id': 'com.example.game.sdktest', 'version': '1.0.2', 'build_number': '4',
                       'output_dir': str(self.root / 'delivery with space')}
        d.write_json(self.config_file, self.config)

    def test_prepare_keeps_original_and_framework(self):
        c = d.load_config(self.config_file)
        ws, team = d.prepare(c)
        d.emit_command(c)
        copy = plistlib.loads((ws.parent / 'Unity-iPhone.xcodeproj/project.pbxproj').read_bytes())
        self.assertEqual(copy['objects']['debug']['buildSettings']['PRODUCT_BUNDLE_IDENTIFIER'], c['test_bundle_id'])
        self.assertEqual(copy['objects']['framework-debug']['buildSettings']['PRODUCT_BUNDLE_IDENTIFIER'], 'com.unity3d.framework')
        info = plistlib.loads((ws.parent / 'Info-test.plist').read_bytes())
        self.assertEqual((info['CFBundleShortVersionString'], info['CFBundleVersion']), ('1.0.2', '4'))
        scheme = ET.parse(ws.parent / 'Unity-iPhone.xcodeproj/xcshareddata/xcschemes/SDK03-Test.xcscheme')
        self.assertTrue(scheme.find('.//BuildableReference').attrib['ReferencedContainer'].startswith('container:/'))
        self.assertEqual(self.before, (self.project_file.read_bytes(), (Path(c['project_root'])/'Info.plist').read_bytes()))
        self.assertTrue((Path(c['output_dir'])/'一键安装测试包.command').stat().st_mode & 0o111)

    def test_candidates_no_ddi_and_offline_wifi(self):
        self.assertEqual(d.select_device([device()])['identifier'], 'phone')
        self.assertIsNone(d.select_device([device(transport='localNetwork')]))
        online = device(transport='localNetwork', tunnel='connected')
        self.assertEqual(d.select_device([online])['identifier'], 'phone')
        with self.assertRaises(d.DeliveryError):
            d.select_device([device('one'), device('two')])
        self.assertEqual(d.select_device([device('one'), device('two')], 'two-udid')['identifier'], 'two')

    def test_same_bundle_and_ambiguous_team_stop(self):
        c = d.load_config(self.config_file)
        c['test_bundle_id'] = 'com.example.game'
        with self.assertRaises(d.DeliveryError):
            d.prepare(c)
        self.assertEqual(d.choose_team(None, 'A', {'A', 'B'}), 'A')
        self.assertEqual(d.choose_team(None, 'X', {'B'}), 'B')
        with self.assertRaises(d.DeliveryError):
            d.choose_team(None, 'X', {'A', 'B'})
        with self.assertRaises(d.DeliveryError):
            d.choose_team('X', 'A', {'A'})

    def test_no_device_generates_retry_without_build(self):
        real_run = d.run
        def fake_run(args, **kwargs):
            if 'devicectl' in args:
                self.assertIn('list', args)
                d.write_json(Path(args[args.index('--json-output')+1]), {'result': {'devices': []}})
                return ''
            return real_run(args, **kwargs)
        with patch.object(d, 'developer_env', return_value={}), patch.object(d, 'run', side_effect=fake_run):
            self.assertEqual(d.main(['--config', str(self.config_file)]), 0)
        out = Path(self.config['output_dir'])
        report = json.loads(next((out/'logs').glob('*/report.json')).read_text())
        self.assertEqual(report['state'], 'no_device_command_ready')
        self.assertTrue((out/'一键安装测试包.command').exists())
        self.assertFalse((out/'DerivedData').exists())

    def test_connected_flow_build_before_install_then_verify(self):
        real_run = d.run
        calls = []
        out = Path(self.config['output_dir'])
        def fake_run(args, **kwargs):
            if 'xcodebuild' in args[0]:
                calls.append('build')
                app = out/'DerivedData/Build/Products/Debug-iphoneos/Game.app'
                app.mkdir(parents=True)
                (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': self.config['test_bundle_id'],
                    'CFBundleShortVersionString': '1.0.2', 'CFBundleVersion': '4'}))
                return ''
            if args[0].endswith('codesign'):
                calls.append('codesign')
                return ''
            if 'devicectl' in args:
                dest = Path(args[args.index('--json-output')+1])
                if 'list' in args:
                    result = {'devices': [device()]}
                elif 'details' in args:
                    result = device()
                elif 'install' in args:
                    self.assertIn('build', calls)
                    calls.append('install')
                    result = {}
                elif 'apps' in args:
                    self.assertIn('install', calls)
                    calls.append('verify-installed')
                    result = {'apps': [{'bundleIdentifier': self.config['test_bundle_id'], 'version': '1.0.2', 'bundleVersion': '4'}]}
                elif 'launch' in args:
                    self.assertIn('verify-installed', calls)
                    calls.append('launch')
                    result = {}
                else:
                    self.fail(str(args))
                d.write_json(dest, {'result': result})
                return ''
            return real_run(args, **kwargs)
        with patch.object(d, 'developer_env', return_value={}), patch.object(d, 'run', side_effect=fake_run), \
             patch.object(d, 'signing_teams', return_value={'COMPANY123'}), \
             patch.object(d, 'verify_profile', return_value={'expiration_utc': '2030-01-01T00:00:00Z'}):
            self.assertEqual(d.main(['--config', str(self.config_file)]), 0)
        self.assertEqual(calls, ['build', 'codesign', 'install', 'verify-installed', 'launch'])
        report = json.loads(next((out/'logs').glob('*/report.json')).read_text())
        self.assertEqual(report['state'], 'installed_launched')

    def test_reject_keys_in_delivery_config(self):
        self.config['appsflyer_dev_key'] = 'not-a-real-key'
        d.write_json(self.config_file, self.config)
        with self.assertRaises(d.DeliveryError):
            d.load_config(self.config_file)

if __name__ == '__main__':
    unittest.main(verbosity=2)
