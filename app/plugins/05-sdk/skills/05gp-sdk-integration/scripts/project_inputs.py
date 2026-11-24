#!/usr/bin/env python3
"""Validate resolved integration inputs; print only non-secret decisions. Python 3.9+."""
import argparse
import copy
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

PACKAGE = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+")
COORDINATE = re.compile(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+\-]+")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def non_placeholder(value, field):
    require(isinstance(value, str) and bool(value.strip()), field + ' is missing')
    require(value == value.strip(), field + ' has unintended surrounding whitespace')
    require(not any(mark in value for mark in ('<', '>', 'YOUR_', 'REPLACE_', 'TODO')),
            field + ' still contains a placeholder')
    return value


def package_name(value, field):
    require(isinstance(value, str) and bool(PACKAGE.fullmatch(value)), field + ' is not a package name')
    return value


def http_url(value, field):
    if value is None:
        return
    non_placeholder(value, field)
    parsed = urlparse(value)
    require(parsed.scheme in ('https', 'http') and bool(parsed.netloc), field + ' must be an HTTP(S) URL')
    require(not parsed.username and not parsed.password, field + ' must not embed credentials')


def load_inputs(path, require_project=True, require_host=False):
    with Path(path).open(encoding='utf-8') as stream:
        config = json.load(stream)
    require(isinstance(config, dict), 'Inputs must be a JSON object')
    config = copy.deepcopy(config)
    project = config.get('project_dir')
    non_placeholder(project, 'project_dir')
    require(Path(project).is_absolute(), 'project_dir must be absolute')
    if require_project:
        require(Path(project).is_dir(), 'project_dir does not exist')
        require(any((Path(project) / name).is_file() for name in ('settings.gradle', 'settings.gradle.kts')),
                'project_dir is not the Android Gradle project root')
    production = package_name(config.get('production_application_id'), 'production_application_id')
    require(not production.startswith('com.example.'), 'production_application_id is still an example')
    test = config.get('test_application_id') or production + '.sdktest'
    package_name(test, 'test_application_id')
    require(test != production, 'Test and production application IDs must differ')
    config['test_application_id'] = test
    name = config.get('app_version_name')
    if name is not None:
        non_placeholder(name, 'app_version_name')
    code = config.get('app_version_code')
    require(code is None or (type(code) is int and 1 <= code <= 2100000000), 'app_version_code must be from 1 to 2100000000, or null')

    pa = config.get('pa')
    require(isinstance(pa, dict), 'pa must be an object')
    require(isinstance(pa.get('maven_coordinate'), str) and bool(COORDINATE.fullmatch(pa['maven_coordinate'])),
            'pa.maven_coordinate must be group:artifact:version')
    http_url(pa.get('repository_url'), 'pa.repository_url')
    http_url(pa.get('expected_domain'), 'pa.expected_domain')
    pa.setdefault('mode', 0)
    pa.setdefault('att', 1)
    require(type(pa['mode']) is int and pa['mode'] in (0, 1, 2), 'pa.mode must match the verified 0/1/2 contract')
    require(type(pa['att']) is int, 'pa.att must be an integer')
    pa.setdefault('identity_policy', 'persistent_installation')
    require(pa['identity_policy'] in ('persistent_installation', 'existing_provider'), 'Unknown pa.identity_policy')

    adjust = config.get('adjust')
    require(isinstance(adjust, dict) and type(adjust.get('enabled')) is bool, 'adjust.enabled must be explicit true/false')
    if adjust['enabled']:
        require(isinstance(adjust.get('maven_coordinate'), str) and bool(COORDINATE.fullmatch(adjust['maven_coordinate'])),
                'adjust.maven_coordinate must be group:artifact:version')
        require(adjust.get('environment') in ('sandbox', 'production'), 'adjust.environment must be sandbox or production')
        non_placeholder(adjust.get('app_token'), 'adjust.app_token')
        mappings = adjust.get('event_tokens')
        require(isinstance(mappings, dict), 'adjust.event_tokens must be an object')
        for index, (event, token) in enumerate(mappings.items(), 1):
            non_placeholder(event, 'adjust.event_tokens event name #' + str(index))
            non_placeholder(token, 'adjust.event_tokens token #' + str(index))

    build = config.setdefault('build', {})
    require(isinstance(build, dict), 'build must be an object')
    build.setdefault('module', ':launcher')
    build.setdefault('build_type', 'debug')
    require(isinstance(build['module'], str) and bool(re.fullmatch(r':[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)*', build['module'])),
            'build.module must be an actual Gradle project path')
    require(isinstance(build['build_type'], str) and bool(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', build['build_type'])),
            'build.build_type is invalid')
    if build.get('sdk_dir') is not None:
        require(isinstance(build['sdk_dir'], str) and Path(build['sdk_dir']).is_absolute(), 'build.sdk_dir must be absolute')

    host = config.setdefault('host', {})
    require(isinstance(host, dict), 'host must be an object')
    if require_host:
        package_name(host.get('package_name'), 'host.package_name')
        package_name(host.get('base_activity'), 'host.base_activity')
        require(pa['identity_policy'] == 'persistent_installation',
                'Renderer cannot replace an existing account provider; merge the runtime UID manually')

    delivery = config.setdefault('delivery', {})
    require(isinstance(delivery, dict), 'delivery must be an object')
    for key, default in [('test_apk', True), ('install', False), ('aab', False)]:
        delivery.setdefault(key, default)
        require(type(delivery[key]) is bool, 'delivery.' + key + ' must be boolean')
    if delivery.get('output_dir') is not None:
        require(isinstance(delivery['output_dir'], str) and Path(delivery['output_dir']).is_absolute(),
                'delivery.output_dir must be absolute')
    return config


def sanitized_summary(config):
    adjust = config['adjust']
    return {
        'project_dir': config['project_dir'],
        'production_application_id': config['production_application_id'],
        'test_application_id': config['test_application_id'],
        'app_version_name': config.get('app_version_name') or 'inherit actual project',
        'app_version_code': config.get('app_version_code') or 'inherit actual project',
        'pa_maven_coordinate': config['pa']['maven_coordinate'],
        'pa_mode': config['pa']['mode'],
        'pa_att': config['pa']['att'],
        'adjust_enabled': adjust['enabled'],
        'adjust_environment': adjust.get('environment') if adjust['enabled'] else None,
        'adjust_event_names': list(adjust.get('event_tokens', {})) if adjust['enabled'] else [],
        'build_module': config['build']['module'],
        'build_type': config['build']['build_type'],
        'delivery': config['delivery'],
        'note': 'Input validation only; does not verify Maven availability, API compatibility or backend configuration.'
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--require-host', action='store_true', help='Require a verified host package/base class for rendering')
    args = parser.parse_args()
    try:
        config = load_inputs(args.config, require_host=args.require_host)
        print(json.dumps(sanitized_summary(config), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, TypeError) as error:
        # JSONDecodeError text can quote malformed secret input; report its location only.
        if isinstance(error, json.JSONDecodeError):
            print('Invalid JSON at line {}, column {}'.format(error.lineno, error.colno), file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
