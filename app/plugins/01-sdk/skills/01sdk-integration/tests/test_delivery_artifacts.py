import importlib.util
import json
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'scripts/check_delivery_artifacts.py'
spec=importlib.util.spec_from_file_location('delivery',SCRIPT)
delivery=importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)

class DeliveryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=Path(self.tmp.name);self.project=self.root/'Project';self.archive=self.root/'Project.zip'
  files={'Assets/Game.cs':'class Game {}','Assets/Game.cs.meta':'guid: fixture','Assets/IntegrationConfig.json':'{"signingKey":"CANARY_SECRET"}','Packages/manifest.json':'{"dependencies":{}}','ProjectSettings/ProjectVersion.txt':'m_EditorVersion: 6000.3.20f1','ProjectSettings/ProjectSettings.asset':'PlayerSettings: {}'}
  for rel,text in files.items():p=self.project/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
  self.app=self.root/'Fixture.app';self.app.mkdir()
  with (self.app/'Info.plist').open('wb') as f:plistlib.dump({'CFBundleIdentifier':'com.example.fixture'},f)
  self.metadata=self.app/'Data/Managed/Metadata/global-metadata.dat';self.metadata.parent.mkdir(parents=True);self.metadata.write_bytes(b'\xaf\x1b\xb1\xfa'+b'UnityEngine FixtureNormalRuntime')
  self.binary=self.app/'Frameworks/UnityFramework.framework/UnityFramework';self.binary.parent.mkdir(parents=True);self.binary.write_bytes(b'\xcf\xfa\xed\xfe'+b'NormalNativeRuntime')
  self.pack()
 def pack(self,exclude=(),replace=None,extra=None):
  with zipfile.ZipFile(self.archive,'w') as z:
   for p in self.project.rglob('*'):
    if p.is_file():
     rel=p.relative_to(self.project).as_posix()
     if rel not in exclude:z.writestr('Project/'+rel,(replace or {}).get(rel,p.read_bytes()))
   for name,data in (extra or {}).items():z.writestr(name,data)
 def check(self,**kw):return delivery.check_artifacts(self.project,self.archive,self.app,**kw)
 def test_clean_artifacts_pass_without_claiming_device_validation(self):
  r=self.check();self.assertTrue(r['passed']);self.assertFalse(r['installed_device_verified']);self.assertFalse(r['cold_start_verified']);self.assertFalse(r['sdk_delivery_verified'])
 def test_missing_runtime_file_fails(self):self.pack(exclude=['Assets/Game.cs']);self.assertFalse(self.check()['passed'])
 def test_changed_runtime_file_fails(self):self.pack(replace={'Assets/Game.cs':b'old code'});self.assertFalse(self.check()['passed'])
 def test_unexpected_file_fails(self):self.pack(extra={'Project/Assets/Unexpected.cs':b'class X {}'});self.assertFalse(self.check()['passed'])
 def test_explicit_build_helper_exclusion_allowed(self):
  p=self.project/'Assets/Editor/DeviceTestBuild.cs';p.parent.mkdir();p.write_text('CRYSTAL_PARTNER_VERIFY')
  self.pack(exclude=['Assets/Editor/DeviceTestBuild.cs'])
  self.assertTrue(self.check(excludes=['Assets/Editor/DeviceTestBuild.cs'])['passed'])
 def test_wildcard_exclusion_is_rejected(self):
  with self.assertRaises(ValueError):self.check(excludes=['Assets/*.cs'])
 def test_traversal_entry_is_rejected(self):self.pack(extra={'Project/../../outside.txt':b'data'});self.assertFalse(self.check()['passed'])
 def test_duplicate_entry_is_rejected(self):
  with warnings.catch_warnings():
   warnings.simplefilter('ignore')
   with zipfile.ZipFile(self.archive,'a') as z:z.writestr('Project/Assets/Game.cs',b'old code')
  self.assertFalse(self.check()['passed'])
 def test_archive_test_harness_is_rejected(self):
  p=self.project/'Assets/Automation.cs';p.write_text('class PartnerDeviceVerification {}');self.pack();self.assertFalse(self.check()['passed'])
 def test_clean_zip_does_not_hide_compiled_test_harness(self):
  self.metadata.write_bytes(self.metadata.read_bytes()+b' PartnerDeviceVerification')
  r=self.check();self.assertTrue(r['archive']['passed']);self.assertFalse(r['app']['passed']);self.assertFalse(r['passed'])
 def test_native_test_hook_is_detected(self):self.binary.write_bytes(self.binary.read_bytes()+b' CrystalPartnerCapture');self.assertFalse(self.check()['passed'])
 def test_missing_metadata_does_not_pass(self):self.metadata.unlink();self.assertFalse(self.check()['passed'])
 def test_invalid_metadata_does_not_pass(self):self.metadata.write_bytes(b'not a Unity metadata file');self.assertFalse(self.check()['passed'])
 def test_normal_white_color_or_bootstrap_is_not_a_test_marker(self):
  (self.project/'Assets/Game.cs').write_text('RuntimeInitializeOnLoadMethod Color.white');self.pack();self.assertTrue(self.check()['passed'])
 def test_report_never_echoes_configuration_content(self):
  self.pack(replace={'Assets/IntegrationConfig.json':b'{"signingKey":"OTHER_SECRET"}'})
  report=json.dumps(self.check());self.assertNotIn('CANARY_SECRET',report);self.assertNotIn('OTHER_SECRET',report)
 def test_additional_marker_is_supported(self):
  self.binary.write_bytes(self.binary.read_bytes()+b' CustomLaunchAutomation')
  self.assertFalse(self.check(markers=['CustomLaunchAutomation'])['passed'])
 def test_cli_exit_codes(self):
  args=[sys.executable,str(SCRIPT),'--project',str(self.project),'--archive',str(self.archive),'--app',str(self.app)]
  ok=subprocess.run(args,capture_output=True,text=True);self.assertEqual(ok.returncode,0,ok.stderr)
  self.metadata.write_bytes(self.metadata.read_bytes()+b' __partnerQA')
  fail=subprocess.run(args,capture_output=True,text=True);self.assertEqual(fail.returncode,1);self.assertFalse(json.loads(fail.stdout)['passed'])
  invalid=subprocess.run([sys.executable,str(SCRIPT),'--archive',str(self.archive)],capture_output=True,text=True);self.assertEqual(invalid.returncode,2)

if __name__=='__main__':unittest.main()
