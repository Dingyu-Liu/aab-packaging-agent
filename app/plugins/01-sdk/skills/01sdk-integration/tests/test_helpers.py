import copy
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

inspect_project = load('inspect_unity').inspect_project
summarize_report = load('check_device_report').summarize_report

def report():
    rotations = []
    for name, orientation, w, h, sw, sh, cw, ch in [
        ('portrait', 'Portrait', 1290, 2796, 1290, 2517, 430, 873),
        ('landscape-left', 'LandscapeLeft', 2796, 1290, 2442, 1227, 814, 430),
        ('landscape-right', 'LandscapeRight', 2796, 1290, 2442, 1227, 814, 430),
    ]:
        rotations.append({'requested': name, 'passed': True,
            'viewport': {'orientation': orientation, 'width': w, 'height': h,
                'safeArea': {'width': sw, 'height': sh},
                'webViewFrame': {'x': 0, 'y': 0, 'width': w, 'height': h}},
            'javascriptViewport': {'innerWidth': cw, 'innerHeight': ch, 'devicePixelRatio': 3}})
    return {'startedAtUtc': '2026-01-02T10:00:05Z', 'finishedAtUtc': '2026-01-02T10:00:20Z',
        'phase': 'complete', 'outcome': 'passed', 'cleanupCompleted': True,
        'webReport': {'passed': True, 'cases': [{'name': 'case-' + str(i), 'passed': True} for i in range(16)]},
        'orientations': rotations,
        'diagnostics': {'appsFlyerInitialized': True, 'facebookInitialized': True,
            'afLastSessionResponseCode': 200, 'afLastEventResponseCode': 200},
        'runtimeStatus': {'entryError': 'entry_unavailable_0'}}

class InspectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.project = self.base / 'project'
        for folder in ['Assets', 'Packages', 'ProjectSettings']:
            (self.project / folder).mkdir(parents=True)
        (self.project / 'ProjectSettings/ProjectVersion.txt').write_text('m_EditorVersion: 6000.3.20f1\n')
        self.app = self.base / 'Editor/Unity.app'
        (self.app / 'Contents/PlaybackEngines/MacStandaloneSupport').mkdir(parents=True)
        with (self.app / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump({'CFBundleVersion': '6000.3.20f1'}, stream)
        self.addCleanup(self.tmp.cleanup)
    def test_sibling_ios_module_is_found(self):
        module = self.app.parent / 'PlaybackEngines/iOSSupport'
        module.mkdir(parents=True)
        (module / 'modules.asset').touch()
        result = inspect_project(self.project, self.app)
        self.assertIn(str(module.resolve()), result.get('ios_module_candidates', []))
        self.assertIs(result.get('editor_api_support_verified'), False)
    def test_editor_version_mismatch_is_explicit(self):
        with (self.app / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump({'CFBundleVersion': '2021.3.25f1'}, stream)
        self.assertIs(inspect_project(self.project, self.app).get('editor_version_matches'), False)
    def test_manifest_urls_are_not_printed(self):
        (self.project / 'Packages/manifest.json').write_text(json.dumps({'dependencies': {
            'com.example.tool': 'https://user:CANARY_SECRET@example.invalid/private.git'}}))
        result = inspect_project(self.project, self.app)
        self.assertNotIn('CANARY_SECRET', json.dumps(result))
        self.assertIn('com.example.tool', result.get('packages', {}))
    def test_non_project_is_rejected(self):
        with self.assertRaises(ValueError): inspect_project(self.base, self.app)

class ReportTests(unittest.TestCase):
    def check(self, data):
        return summarize_report(data, '2026-01-02T10:00:00Z')
    def test_fresh_full_report_passes_with_safe_area(self):
        result = self.check(report())
        self.assertIs(result.get('test_run_passed'), True)
        self.assertIs(result.get('orientations_passed'), True)
        self.assertIs(result.get('sdk', {}).get('evidence_from_current_run'), True)
    def test_stale_report_is_rejected_even_if_not_the_previous_run(self):
        data = report(); data['startedAtUtc'] = '2026-01-02T09:59:00Z'
        result = self.check(data)
        self.assertIs(result.get('fresh'), False)
        self.assertIs(result.get('test_run_passed'), False)
        self.assertIs(result.get('sdk', {}).get('evidence_from_current_run'), False)
    def test_naive_report_time_is_rejected(self):
        data = report(); data['startedAtUtc'] = '2026-01-02T10:00:05'
        self.assertIs(self.check(data).get('fresh'), False)
    def test_empty_cases_cannot_claim_success(self):
        data = report(); data['webReport']['cases'] = []
        self.assertIs(self.check(data).get('web_bridge_passed'), False)
    def test_duplicate_cases_cannot_claim_success(self):
        data = report(); data['webReport']['cases'][1]['name'] = 'case-0'
        self.assertIs(self.check(data).get('web_bridge_passed'), False)
    def test_truthy_string_is_not_boolean_success(self):
        data = report(); data['webReport']['cases'][0]['passed'] = 'true'
        self.assertIs(self.check(data).get('web_bridge_passed'), False)
    def test_stale_portrait_viewport_rejected_in_landscape(self):
        data = report(); data['orientations'][1]['javascriptViewport'].update(innerWidth=430, innerHeight=873)
        self.assertIs(self.check(data).get('orientations_passed'), False)
    def test_oversized_viewport_rejected(self):
        data = report(); data['orientations'][1]['javascriptViewport']['innerWidth'] = 1000
        self.assertIs(self.check(data).get('orientations_passed'), False)
    def test_wrong_native_frame_rejected(self):
        data = report(); data['orientations'][1]['viewport']['webViewFrame']['width'] = 1290
        self.assertIs(self.check(data).get('orientations_passed'), False)
    def test_zero_dpr_rejected(self):
        data = report(); data['orientations'][1]['javascriptViewport']['devicePixelRatio'] = 0
        self.assertIs(self.check(data).get('orientations_passed'), False)
    def test_http_200_does_not_establish_dashboard_or_entry_acceptance(self):
        result = self.check(report())
        self.assertEqual(result.get('sdk', {}).get('appsflyer_event_http'), 200)
        self.assertIs(result.get('vendor_dashboard_verified'), False)
        self.assertIs(result.get('entry_contract_verified'), False)
    def test_summary_does_not_copy_attribution_identifiers(self):
        data = report(); data['diagnostics']['appsFlyerId'] = 'CANARY_DEVICE_IDENTIFIER'
        self.assertNotIn('CANARY_DEVICE_IDENTIFIER', json.dumps(self.check(data)))
    def test_entry_failure_kept_separate_from_local_bridge(self):
        result = self.check(report())
        self.assertIs(result.get('web_bridge_passed'), True)
        self.assertEqual(result.get('entry_error'), 'entry_unavailable_0')

if __name__ == '__main__': unittest.main()
