#!/usr/bin/env python3
"""Read-only Unity project/module inventory; does not launch or modify Unity."""
import argparse
import json
from pathlib import Path
import plistlib
import re


def inspect_project(project, editor_app=None):
    project = Path(project).expanduser().resolve()
    version_file = project / 'ProjectSettings/ProjectVersion.txt'
    if not (project / 'Assets').is_dir() or not version_file.is_file():
        raise ValueError('Expected a Unity project with Assets and ProjectSettings/ProjectVersion.txt')
    match = re.search(r'^m_EditorVersion:\s*(\S+)', version_file.read_text(), re.MULTILINE)
    if not match:
        raise ValueError('ProjectVersion.txt does not contain m_EditorVersion')
    recorded = match.group(1)
    packages = {}
    manifest = project / 'Packages/manifest.json'
    if manifest.exists():
        dependencies = json.loads(manifest.read_text()).get('dependencies', {})
        for name, value in dependencies.items():
            # A package source URL may contain credentials. Never print it.
            packages[name] = value if isinstance(value, str) and re.fullmatch(r'[0-9][0-9A-Za-z.+-]*', value) else '[non-registry source redacted]'
    candidates = []
    installed = None
    if editor_app:
        app = Path(editor_app).expanduser().resolve()
        info = app / 'Contents/Info.plist'
        if not info.is_file():
            raise ValueError('--editor-app must point to a macOS Unity.app bundle')
        with info.open('rb') as stream:
            metadata = plistlib.load(stream)
        raw = str(metadata.get('CFBundleVersion') or metadata.get('CFBundleShortVersionString') or '')
        version = re.search(r'\d+\.\d+\.\d+[abfp]\d+', raw)
        installed = version.group(0) if version else raw
        for module in [app / 'Contents/PlaybackEngines/iOSSupport', app.parent / 'PlaybackEngines/iOSSupport']:
            if module.is_dir():
                candidates.append(str(module))
    sdk_paths = [str(project / rel) for rel in [
        'Assets/AppsFlyer', 'Assets/FacebookSDK', 'Assets/Adjust', 'Assets/UniWebView',
        'Assets/ExternalDependencyManager', 'Assets/Plugins/iOS',
    ] if (project / rel).exists()]
    entry_paths = sorted(str(p.relative_to(project)) for p in (project / 'Assets').rglob('*.cs')
                         if any(word in p.stem.lower() for word in ['bootstrap', 'launch', 'entry', 'gamemain']))[:40]
    return {'project': str(project), 'project_version': recorded,
            'installed_editor_version': installed,
            'editor_version_matches': installed == recorded if installed is not None else None,
            'ios_module_candidates': candidates, 'editor_api_support_verified': False,
            'module_check_note': 'Confirm BuildPipeline.IsBuildTargetSupported in the selected Editor; filesystem presence alone is insufficient.',
            'packages': packages, 'sdk_paths': sdk_paths, 'entry_script_candidates': entry_paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--editor-app', help='Optional macOS Unity.app path; both module locations are checked')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = inspect_project(args.project, args.editor_app)
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        parser.error(str(error))
    text = json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    else:
        print(text, end='')


if __name__ == '__main__':
    main()
