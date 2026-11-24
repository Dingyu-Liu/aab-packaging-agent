#!/usr/bin/env python3
"""Stream complete SDK project archives and verify CRC and source stability."""
import argparse
import hashlib
import json
import os
import plistlib
import subprocess
from pathlib import Path
import stat
import sys
import zipfile

ROOT_SKIP = {'.git', '.opencode', '.partner-agent', 'Library', 'Temp', 'Obj', 'obj', 'Logs', 'Build', 'Builds', 'UserSettings', 'MemoryCaptures', 'Recordings', '.gradle', '.idea', '.vs', 'node_modules', 'secrets'}
ANY_SKIP = {'.DS_Store', 'xcuserdata', '.git', '__pycache__'}

def inside(root, target):
    try: target.relative_to(root); return True
    except ValueError: return False

def source_files(root, unity):
    root = root.resolve()
    for directory, folders, names in os.walk(str(root), followlinks=False):
        current = Path(directory)
        relative = current.relative_to(root)
        excluded = ANY_SKIP | (ROOT_SKIP if unity and not relative.parts else {'build', 'DerivedData'} if not relative.parts else set())
        folders[:] = sorted(name for name in folders if name not in excluded)
        links = [name for name in folders if (current / name).is_symlink()]
        folders[:] = [name for name in folders if name not in links]
        for name in sorted(names + links):
            path = current / name
            if name in ANY_SKIP or name == '.env' or name.startswith('.env.') or path.suffix.lower() in {'.p12', '.pfx', '.keystore', '.jks', '.mobileprovision'}: continue
            if path.is_symlink():
                if not path.exists() or not inside(root, path.resolve()): raise ValueError('工程中存在指向交付目录外或失效的符号链接：' + str(path.relative_to(root)))
                if os.path.isabs(os.readlink(path)): raise ValueError('工程包含绝对符号链接，请改为工程内相对链接：' + str(path.relative_to(root)))
                yield path, True
            elif path.is_file(): yield path, False

def archive_project(root, destination, prefix, unity):
    root = root.resolve()
    entries = []
    total = 0
    if unity:
        for name in ['Assets', 'Packages', 'ProjectSettings']:
            if not (root / name).is_dir(): raise ValueError('Unity 工程缺少 ' + name)
        manifest = root / 'Packages/manifest.json'
        if manifest.is_file():
            for name, value in json.loads(manifest.read_text()).get('dependencies', {}).items():
                if isinstance(value, str) and value.startswith('file:'):
                    if Path(value[5:]).is_absolute(): raise ValueError('Unity 本地包使用了绝对路径，请复制到工程内并改为相对引用：' + name)
                    target = (root / 'Packages' / value[5:]).resolve()
                    if not target.exists() or not inside(root.resolve(), target): raise ValueError('Unity 本地包依赖尚未包含在交付工程中：' + name)
    if not unity:
        for pbx in root.glob('*.xcodeproj/project.pbxproj'):
            try: project = plistlib.loads(pbx.read_bytes())
            except plistlib.InvalidFileException:
                result = subprocess.run(['/usr/bin/plutil', '-convert', 'xml1', '-o', '-', str(pbx)], capture_output=True, timeout=15)
                if result.returncode: raise ValueError('无法解析 Xcode 工程，未生成完整交付包。')
                project = plistlib.loads(result.stdout)
            for obj in project.get('objects', {}).values():
                path = obj.get('path') if isinstance(obj, dict) else None
                if isinstance(obj, dict) and obj.get('isa') == 'PBXFileReference' and isinstance(path, str) and os.path.isabs(path) and obj.get('sourceTree') not in ['SDKROOT','DEVELOPER_DIR','BUILT_PRODUCTS_DIR']:
                    raise ValueError('Xcode 文件使用绝对引用，请将依赖包含在交付工程内并改为相对引用：' + path)
    temporary = destination.with_suffix(destination.suffix + '.tmp')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=4, allowZip64=True) as archive:
        if unity:
            for folder in ['Assets', 'Packages', 'ProjectSettings']:
                member = zipfile.ZipInfo(prefix + '/' + folder + '/')
                member.create_system = 3; member.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
                archive.writestr(member, b'')
        for path, link in source_files(root, unity):
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            total += info.st_size
            if len(entries) >= 200000 or total > 25 * 1024**3: raise ValueError('交付工程超过 20 万文件或 25 GB，请检查是否混入构建缓存。')
            digest = hashlib.sha256()
            if link:
                value = os.readlink(path).encode()
                member = zipfile.ZipInfo(prefix + '/' + relative)
                member.create_system = 3; member.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(member, value); digest.update(value)
            else:
                member = zipfile.ZipInfo.from_file(str(path), prefix + '/' + relative)
                member.compress_type = zipfile.ZIP_DEFLATED
                with path.open('rb') as source, archive.open(member, 'w', force_zip64=True) as target:
                    for data in iter(lambda: source.read(1024 * 1024), b''): digest.update(data); target.write(data)
                after = path.stat()
                if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns): raise ValueError('归档期间工程发生变化，请重新生成交付：' + relative)
            entries.append({'path': relative, 'bytes': info.st_size, 'sha256': digest.hexdigest(), 'symlink': link})
            if len(entries) % 500 == 0: print('已归档 %s 个工程文件' % len(entries), flush=True)
    with zipfile.ZipFile(temporary) as archive:
        invalid = archive.testzip()
        if invalid: raise ValueError('工程 ZIP CRC 校验失败：' + invalid)
    temporary.replace(destination)
    digest = hashlib.sha256()
    with destination.open('rb') as handle:
        for data in iter(lambda: handle.read(1024 * 1024), b''): digest.update(data)
    return {'path': str(destination), 'sha256': digest.hexdigest(), 'fileCount': len(entries), 'sourceBytes': total, 'crcVerified': True, 'files': entries}

def bundle(directory, output):
    temporary = output.with_suffix('.tmp')
    with zipfile.ZipFile(temporary, 'w', allowZip64=True) as archive:
        for path in sorted(directory.iterdir()):
            if path.is_file() and path not in [output, temporary] and not path.name.startswith('.'):
                archive.write(path, '01SDK最终交付/' + path.name, compress_type=zipfile.ZIP_STORED if path.suffix == '.zip' else zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip(): raise ValueError('最终交付包 CRC 校验失败。')
    temporary.replace(output)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unity', type=Path)
    parser.add_argument('--xcode', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--bundle', action='store_true')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        if args.bundle: bundle(args.out, args.out / '01SDK最终交付.zip')
        else:
            reports = {}
            if args.unity: reports['unity'] = archive_project(args.unity.resolve(), args.out / '最终Unity工程.zip', 'Unity工程', True)
            if args.xcode: reports['xcode'] = archive_project(args.xcode.resolve(), args.out / '最终Xcode工程.zip', 'Xcode工程', False)
            (args.out / 'archive-manifest.json').write_text(json.dumps(reports, ensure_ascii=False, indent=2) + '\n')
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr); raise SystemExit(2)
