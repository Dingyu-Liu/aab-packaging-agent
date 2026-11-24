"""Regression: compare parsed values; never migrate YAML scalar delimiters."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/check_signing_key.py'
spec = importlib.util.spec_from_file_location('check_signing_key', SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

UNITY_HEADER = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\n'


class SigningKeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'Demo.asset'
        self.target = Path(self.tmp.name) / 'config.json'

    def fixture(self, scalar, target, header=UNITY_HEADER):
        self.source.write_text(header + 'MonoBehaviour:\n  sign: ' + scalar + '\n', encoding='utf-8')
        self.target.write_text(json.dumps({'signingKey': target}, ensure_ascii=False), encoding='utf-8')

    def check(self):
        return helper.compare_files(self.source, self.target, 'MonoBehaviour.sign', 'signingKey')

    def cli(self):
        return subprocess.run([sys.executable, str(SCRIPT), '--source', str(self.source),
                               '--target', str(self.target)], capture_output=True, text=True,
                              env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))

    def test_single_quoted_scalar_matches_plain_json_value(self):
        self.fixture("'example-secret'", 'example-secret')
        result = self.check()
        self.assertTrue(result['equal'])
        self.assertFalse(result['target_has_extra_outer_quotes'])

    def test_copied_yaml_single_quote_delimiters_are_detected(self):
        self.fixture("'example-secret'", "'example-secret'")
        result = self.check()
        self.assertFalse(result['equal'])
        self.assertTrue(result['target_has_extra_outer_quotes'])
        self.assertEqual(result['target_characters'] - result['source_characters'], 2)

    def test_copied_yaml_double_quote_delimiters_are_detected(self):
        self.fixture('"example-secret"', '"example-secret"')
        self.assertTrue(self.check()['target_has_extra_outer_quotes'])

    def test_double_quoted_escape_sequences_are_decoded(self):
        self.fixture(r'"line\nbreak\\slash"', 'line\nbreak\\slash')
        self.assertTrue(self.check()['equal'])

    def test_doubled_single_quote_is_part_of_key(self):
        self.fixture("'can''t-trim'", "can't-trim")
        self.assertTrue(self.check()['equal'])

    def test_legitimate_outer_quotes_are_preserved(self):
        self.fixture("'\"quoted-value\"'", '"quoted-value"')
        result = self.check()
        self.assertTrue(result['equal'])
        self.assertFalse(result['target_has_extra_outer_quotes'])
        self.target.write_text(json.dumps({'signingKey': 'quoted-value'}))
        self.assertFalse(self.check()['equal'])

    def test_key_whitespace_is_not_trimmed(self):
        self.fixture("' example-secret '", ' example-secret ')
        self.assertTrue(self.check()['equal'])
        self.target.write_text(json.dumps({'signingKey': 'example-secret'}))
        self.assertFalse(self.check()['equal'])

    def test_utf8_bytes_distinguished_from_character_count(self):
        self.fixture("'测例'", '测例')
        result = self.check()
        self.assertEqual(result['source_characters'], 2)
        self.assertEqual(result['source_utf8_bytes'], 6)

    def test_only_matching_document_selected_in_unity_yaml(self):
        self.fixture("'example-secret'", 'example-secret')
        self.source.write_text(self.source.read_text() + '--- !u!1 &7\nGameObject:\n  m_Name: Preview\n')
        self.assertTrue(self.check()['equal'])

    def test_multiple_matching_documents_are_rejected(self):
        self.fixture("'example-secret'", 'example-secret')
        self.source.write_text(self.source.read_text() + '--- !u!114 &8\nMonoBehaviour:\n  sign: other\n')
        with self.assertRaisesRegex(ValueError, 'ambiguous_source_field'):
            self.check()

    def test_non_string_or_empty_values_are_rejected(self):
        for scalar in ['1234', 'true', 'null', "''"]:
            with self.subTest(scalar=scalar):
                self.fixture(scalar, 'example-secret')
                with self.assertRaises(ValueError): self.check()
        self.fixture("'example-secret'", 1234)
        with self.assertRaises(ValueError): self.check()

    def test_missing_source_field_is_rejected(self):
        self.fixture("'example-secret'", 'example-secret')
        self.source.write_text('MonoBehaviour:\n  other: example-secret\n')
        with self.assertRaisesRegex(ValueError, 'missing_source_field'): self.check()

    def test_missing_target_field_is_rejected(self):
        self.fixture("'example-secret'", 'example-secret')
        self.target.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'missing_target_field'): self.check()

    def test_duplicate_yaml_mapping_key_is_rejected(self):
        self.fixture("'example-secret'", 'example-secret')
        self.source.write_text(self.source.read_text() + '  sign: other\n')
        with self.assertRaisesRegex(ValueError, 'invalid_yaml'): self.check()

    def test_duplicate_json_mapping_key_is_rejected(self):
        self.fixture("'example-secret'", 'example-secret')
        self.target.write_text('{"signingKey":"wrong", "signingKey":"example-secret"}')
        with self.assertRaisesRegex(ValueError, 'invalid_json'): self.check()

    def test_unknown_yaml_tag_is_not_constructed(self):
        self.fixture('!!python/object/apply:builtins.str [example-secret]', 'example-secret')
        with self.assertRaisesRegex(ValueError, 'invalid_yaml'): self.check()

    def test_result_does_not_include_secret_values(self):
        self.fixture("'CANARY_PRIVATE_VALUE'", "'CANARY_PRIVATE_VALUE'")
        result = self.check()
        self.assertNotIn('CANARY_PRIVATE_VALUE', json.dumps(result))
        self.assertIs(result['backend_signature_verified'], False)

    def test_cli_success_and_mismatch_exit_codes(self):
        self.fixture("'CANARY_PRIVATE_VALUE'", 'CANARY_PRIVATE_VALUE')
        before = (self.source.read_bytes(), self.target.read_bytes())
        run = self.cli()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(json.loads(run.stdout)['equal'])
        self.assertEqual((self.source.read_bytes(), self.target.read_bytes()), before)
        self.target.write_text(json.dumps({'signingKey': "'CANARY_PRIVATE_VALUE'"}))
        run = self.cli()
        self.assertEqual(run.returncode, 1)
        self.assertNotIn('CANARY_PRIVATE_VALUE', run.stdout + run.stderr)

    def test_parser_error_output_does_not_echo_secret(self):
        self.fixture("'CANARY_PRIVATE_VALUE", 'example-secret')
        run = self.cli()
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout)['error'], 'invalid_yaml')
        self.assertNotIn('CANARY_PRIVATE_VALUE', run.stdout + run.stderr)

    def test_plain_yaml_and_custom_field_paths_work(self):
        self.source.write_text('config:\n  credentials:\n    api_key: "example-secret"\n')
        self.target.write_text('{"auth":{"token":"example-secret"}}')
        result = helper.compare_files(self.source, self.target, 'config.credentials.api_key', 'auth.token')
        self.assertTrue(result['equal'])


if __name__ == '__main__':
    unittest.main()
