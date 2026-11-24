#!/usr/bin/env python3
"""Read-only comparison of a parsed YAML secret and its migrated JSON value.

Requires PyYAML. Values and parser excerpts are never printed. Exit codes:
0 = equal, 1 = different, 2 = dependency, input, or parsing problem.
"""
import argparse
import json
from pathlib import Path
import re


class CheckError(ValueError):
    """A fixed error code suitable for output without exposing input values."""


def _read(path):
    try:
        return Path(path).read_text(encoding='utf-8-sig')
    except (OSError, UnicodeError):
        raise CheckError('file_unreadable') from None


def _yaml_documents(text):
    try:
        import yaml
    except ImportError:
        raise CheckError('pyyaml_required') from None

    class UniqueSafeLoader(yaml.SafeLoader):
        pass

    def unique_mapping(loader, node, deep=False):
        loader.flatten_mapping(node)
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise ValueError('duplicate_mapping_key')
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueSafeLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)
    # Unity repeats !u! document tags without repeating %TAG. Remove only those
    # document-header type markers; scalar text, quoting and escapes stay intact.
    text = re.sub(r'(?m)^---[ \t]+!u!\d+[ \t]+(&-?\d+)(?:[ \t]+stripped)?[ \t]*\r?$',
                  r'--- \1', text)
    try:
        return list(yaml.load_all(text, Loader=UniqueSafeLoader))
    except (yaml.YAMLError, ValueError, TypeError, RecursionError):
        # YAML exceptions may contain the secret-bearing source line.
        raise CheckError('invalid_yaml') from None


def _json_document(text):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_mapping_key')
            result[key] = value
        return result

    try:
        return json.loads(text, object_pairs_hook=unique_pairs)
    except (ValueError, RecursionError):
        raise CheckError('invalid_json') from None


def _select(documents, field, side):
    parts = field.split('.')
    if not all(parts):
        raise CheckError('invalid_field_path')
    matches = []
    for document in documents:
        value = document
        for key in parts:
            if not isinstance(value, dict) or key not in value:
                break
            value = value[key]
        else:
            matches.append(value)
    if not matches:
        raise CheckError('missing_' + side + '_field')
    if len(matches) != 1:
        raise CheckError('ambiguous_' + side + '_field')
    if not isinstance(matches[0], str):
        raise CheckError(side + '_field_not_string')
    if matches[0] == '':
        raise CheckError(side + '_field_empty')
    return matches[0]


def compare_files(source, target, source_field='MonoBehaviour.sign', target_field='signingKey'):
    source_value = _select(_yaml_documents(_read(source)), source_field, 'source')
    target_value = _select([_json_document(_read(target))], target_field, 'target')
    try:
        source_bytes = source_value.encode('utf-8')
        target_bytes = target_value.encode('utf-8')
    except UnicodeError:
        raise CheckError('invalid_utf8_value') from None
    return {
        'equal': source_bytes == target_bytes,
        'source_characters': len(source_value),
        'target_characters': len(target_value),
        'source_utf8_bytes': len(source_bytes),
        'target_utf8_bytes': len(target_bytes),
        'target_has_extra_outer_quotes': any(
            target_value == quote + source_value + quote for quote in ("'", '"')),
        'backend_signature_verified': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Source YAML or Unity text .asset')
    parser.add_argument('--target', required=True, type=Path, help='Migrated JSON configuration')
    parser.add_argument('--source-field', default='MonoBehaviour.sign', help='Dot-separated mapping keys')
    parser.add_argument('--target-field', default='signingKey', help='Dot-separated mapping keys')
    args = parser.parse_args()
    try:
        result = compare_files(args.source, args.target, args.source_field, args.target_field)
    except CheckError as error:
        print(json.dumps({'error': str(error), 'backend_signature_verified': False}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result['equal'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
