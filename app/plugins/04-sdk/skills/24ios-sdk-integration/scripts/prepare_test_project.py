#!/usr/bin/env python3
"""Prepare an isolated Unity iOS test configuration; never build or install.

Only the selected app target/configuration is overridden. Source files stay in
place and the copied project's absolute projectDirPath points back to them.
The copied project.pbxproj is a standard XML plist so edits are structural,
not regular-expression substitutions across unrelated targets.

Requires macOS /usr/bin/plutil and Python 3.8+. Use a dedicated output directory.
An unchanged managed output can be regenerated; unknown or edited files cause
an error instead of being overwritten. No account, signing, or SDK values are
invented. The caller must validate the actual built app before installation.
"""

import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

OWNER = "24ios-sdk-integration.prepare_test_project"
MARKER = ".24ios-test-project.json"
VERSION_RE = re.compile(r"[0-9]+(?:\.[0-9]+){0,2}\Z")
BUNDLE_RE = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z")


class PreparationError(Exception):
    pass


def fail(message):
    raise PreparationError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def is_inside(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def load_pbxproj(data):
    result = subprocess.run(
        ["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        fail("plutil 无法读取 project.pbxproj：" + result.stderr.decode(errors="replace").strip())
    try:
        model = json.loads(result.stdout)
    except ValueError as exc:
        fail("无法解析 plutil 输出：" + str(exc))
    if not isinstance(model, dict) or not isinstance(model.get("objects"), dict):
        fail("project.pbxproj 缺少 objects 字典。")
    return model


def read_project_files(project):
    """Copy shared project metadata without copying Xcode user state."""
    result = {}
    for root, directories, files in os.walk(project, followlinks=False):
        directories[:] = sorted(name for name in directories if name != "xcuserdata")
        for name in directories:
            if (Path(root) / name).is_symlink():
                fail("工程元数据包含目录软链接，无法安全复制：" + str(Path(root) / name))
        for name in sorted(files):
            if name == ".DS_Store":
                continue
            path = Path(root) / name
            if path.is_symlink() or not path.is_file():
                fail("工程元数据不是普通文件：" + str(path))
            result[path.relative_to(project).as_posix()] = path.read_bytes()
    return result


def object_for(objects, key, isa):
    value = objects.get(key)
    if not isinstance(value, dict) or value.get("isa") != isa:
        fail("工程对象缺失或类型不匹配：{}（预期 {}）。".format(key, isa))
    return value


def validate_version(value, label):
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        fail(label + "须为 1～3 段数字，例如 1.0.4 或 2。")
    return value


def resolve_info_path(setting, source_dir):
    if not isinstance(setting, str) or not setting:
        fail("所选 target/configuration 必须显式设置 INFOPLIST_FILE；不支持仅从 xcconfig 继承或自动生成。")
    for variable in ("SRCROOT", "SOURCE_ROOT", "PROJECT_DIR"):
        setting = setting.replace("$(" + variable + ")", str(source_dir))
        setting = setting.replace("${" + variable + "}", str(source_dir))
    if "$" in setting:
        fail("INFOPLIST_FILE 含不支持的构建变量：" + setting)
    path = Path(setting)
    path = (path if path.is_absolute() else source_dir / path).resolve()
    if not path.is_file():
        fail("找不到源 Info.plist：" + str(path))
    return path


def validate_managed_output(output, source_project):
    """Reject unmanaged content and edits, including unknown empty directories."""
    if not output.exists():
        return
    if output.is_symlink() or not output.is_dir():
        fail("输出路径必须是普通目录：" + str(output))
    if not any(output.iterdir()):
        return
    marker_path = output / MARKER
    if marker_path.is_symlink() or not marker_path.is_file():
        fail("输出目录包含未知文件；请选择空目录或本工具之前生成的目录：" + str(output))
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        fail("输出目录管理标记无效：" + str(exc))
    if (marker.get("owner") != OWNER or marker.get("format") != 1
            or marker.get("source_project") != str(source_project)):
        fail("输出目录不属于此工具/此源工程；请使用新的输出目录。")
    hashes = marker.get("generated_sha256")
    if not isinstance(hashes, dict) or not hashes:
        fail("输出目录管理标记缺少文件清单。")
    expected_files, expected_dirs = {MARKER}, set()
    for relative, expected_hash in hashes.items():
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts or not path.parts or relative == MARKER:
            fail("输出目录管理标记包含不安全路径。")
        expected_files.add(path.as_posix())
        for parent in path.parents:
            if parent != Path("."):
                expected_dirs.add(parent.as_posix())
        actual = output / path
        if actual.is_symlink() or not actual.is_file() or digest(actual.read_bytes()) != expected_hash:
            fail("已生成文件被修改或缺失；拒绝覆盖，请使用新输出目录：" + relative)
    actual_files, actual_dirs = set(), set()
    for path in output.rglob("*"):
        relative = path.relative_to(output).as_posix()
        if path.is_symlink():
            fail("输出目录中出现未知软链接：" + relative)
        if path.is_file():
            actual_files.add(relative)
        elif path.is_dir():
            actual_dirs.add(relative)
        else:
            fail("输出目录中出现非常规文件：" + relative)
    if actual_files != expected_files or actual_dirs != expected_dirs:
        extra = sorted((actual_files - expected_files) | (actual_dirs - expected_dirs))
        fail("输出目录中出现未知文件/目录，拒绝覆盖：" + ", ".join(extra or ["目录结构已改变"]))


def prepare(args):
    raw_project = Path(args.project).expanduser()
    project = raw_project.resolve()
    if not project.is_dir() or project.suffix != ".xcodeproj":
        fail("--project 必须是存在的 .xcodeproj 目录。")
    output_input = Path(args.output_dir).expanduser().absolute()
    if output_input.is_symlink():
        fail("--output-dir 不得是软链接。")
    output = output_input.resolve()
    if is_inside(output, project.parent) or is_inside(project.parent, output):
        fail("输出目录必须放在源工程目录之外，且不能包含源工程。")
    if not BUNDLE_RE.fullmatch(args.bundle_id):
        fail("测试包名必须是有效的反向域名，只包含英文字母、数字、短横线和分隔点。")
    validate_version(args.version, "--version")
    if args.build is not None:
        validate_version(args.build, "--build")
    if not args.scheme or Path(args.scheme).name != args.scheme or args.scheme in (".", ".."):
        fail("--scheme 必须是单个 scheme 名称，不能包含路径。")
    if not Path("/usr/bin/plutil").is_file():
        fail("需要 macOS /usr/bin/plutil。")

    project_files = read_project_files(project)
    project_hashes = {str(project / relative): digest(data) for relative, data in project_files.items()}
    source_data = project_files.get("project.pbxproj")
    if source_data is None:
        fail("源工程缺少 project.pbxproj。")
    model = load_pbxproj(source_data)
    original_model = copy.deepcopy(model)
    objects = model["objects"]
    root = object_for(objects, model.get("rootObject"), "PBXProject")
    targets = [(key, value) for key, value in objects.items()
               if isinstance(value, dict) and value.get("isa") == "PBXNativeTarget"
               and value.get("name") == args.target]
    if len(targets) != 1:
        available = [v.get("name", k) for k, v in objects.items()
                     if isinstance(v, dict) and v.get("isa") == "PBXNativeTarget"]
        fail("必须唯一匹配主 target {!r}，当前匹配 {} 个；可用：{}。".format(args.target, len(targets), ", ".join(available)))
    target_id, target = targets[0]
    if target_id not in root.get("targets", []):
        fail("所选 target 不属于根 PBXProject。")
    if target.get("productType") != "com.apple.product-type.application":
        fail("所选 target 不是主 App；不能把测试包名设置到 framework 或 extension。")
    config_list = object_for(objects, target.get("buildConfigurationList"), "XCConfigurationList")
    configs = [(key, object_for(objects, key, "XCBuildConfiguration"))
               for key in config_list.get("buildConfigurations", [])]
    configs = [(key, value) for key, value in configs if value.get("name") == args.configuration]
    if len(configs) != 1:
        fail("所选 target 必须唯一包含构建配置：" + args.configuration)
    config_id, config = configs[0]
    for key, value in objects.items():
        if (key != target_id and isinstance(value, dict)
                and value.get("isa") in ("PBXNativeTarget", "PBXAggregateTarget", "PBXProject")):
            other_list = objects.get(value.get("buildConfigurationList"), {})
            if config_id in other_list.get("buildConfigurations", []):
                fail("所选构建配置对象被其他 target/project 共享，无法只改主 App。")
    settings = config.get("buildSettings")
    if not isinstance(settings, dict):
        fail("所选构建配置缺少 buildSettings 字典。")
    changed_keys = ("PRODUCT_BUNDLE_IDENTIFIER", "MARKETING_VERSION", "CURRENT_PROJECT_VERSION", "INFOPLIST_FILE",
                    "INFOPLIST_KEY_CFBundleIdentifier", "INFOPLIST_KEY_CFBundleShortVersionString",
                    "INFOPLIST_KEY_CFBundleVersion")
    if any(key.startswith(tuple(name + "[" for name in changed_keys)) for key in settings):
        fail("所选构建配置包含包名/版本/Info.plist 的条件设置；请先显式整理这些条件，避免设备与模拟器产生不同包名。")
    source_dir_setting = root.get("projectDirPath", "")
    if not isinstance(source_dir_setting, str) or "$" in source_dir_setting:
        fail("源 PBXProject.projectDirPath 包含不支持的构建变量。")
    source_dir = (project.parent / source_dir_setting).resolve()
    if not source_dir.is_dir():
        fail("源 projectDirPath 指向的目录不存在：" + str(source_dir))
    if is_inside(output, source_dir) or is_inside(source_dir, output):
        fail("输出目录必须放在源 projectDirPath 目录之外，且不能包含源目录。")
    info_path = resolve_info_path(settings.get("INFOPLIST_FILE"), source_dir)
    if is_inside(info_path, output):
        fail("源 Info.plist 位于输出目录中，拒绝覆盖。")
    info_bytes = info_path.read_bytes()
    try:
        info = plistlib.loads(info_bytes)
    except (plistlib.InvalidFileException, ValueError) as exc:
        fail("源 Info.plist 必须是有效 XML/binary plist：" + str(exc))
    if not isinstance(info, dict):
        fail("源 Info.plist 必须为字典。")
    build = args.build or info.get("CFBundleVersion") or settings.get("CURRENT_PROJECT_VERSION")
    if build in ("$(CURRENT_PROJECT_VERSION)", "${CURRENT_PROJECT_VERSION}"):
        build = settings.get("CURRENT_PROJECT_VERSION")
    if isinstance(build, int):
        build = str(build)
    if not isinstance(build, str) or not VERSION_RE.fullmatch(build):
        fail("无法从 CFBundleVersion/CURRENT_PROJECT_VERSION 确定数字构建号，请显式指定 --build。")

    copied_project = output / project.name
    copied_info = output / "Info-test.plist"
    settings.update(PRODUCT_BUNDLE_IDENTIFIER=args.bundle_id, MARKETING_VERSION=args.version,
                    CURRENT_PROJECT_VERSION=build, INFOPLIST_FILE=str(copied_info))
    for key, value in (("CFBundleIdentifier", args.bundle_id),
                       ("CFBundleShortVersionString", args.version), ("CFBundleVersion", build)):
        info[key] = value
        generated_key = "INFOPLIST_KEY_" + key
        if generated_key in settings:
            settings[generated_key] = value
    root["projectDirPath"] = str(source_dir)
    scheme_relative = "xcshareddata/xcschemes/" + args.scheme + ".xcscheme"
    if scheme_relative not in project_files:
        fail("缺少共享 scheme；请在 Xcode 中将其设为 Shared：" + scheme_relative)
    try:
        scheme = ET.fromstring(project_files[scheme_relative])
    except ET.ParseError as exc:
        fail("共享 scheme XML 无效：" + str(exc))
    selected_seen = False
    for reference in scheme.iter("BuildableReference"):
        container = reference.get("ReferencedContainer", "")
        if not container.startswith("container:") or not container[len("container:"):]:
            fail("scheme 包含不支持的 ReferencedContainer：" + container)
        referenced_path = (project.parent / container[len("container:"):]).resolve()
        if referenced_path != project:
            fail("scheme 引用了其他工程，当前工具只处理单工程 scheme：" + str(referenced_path))
        blueprint = reference.get("BlueprintIdentifier")
        if blueprint not in root.get("targets", []):
            fail("scheme 引用了不存在的 target：" + str(blueprint))
        selected_seen = selected_seen or blueprint == target_id
        reference.set("ReferencedContainer", "container:" + str(copied_project))
    if not selected_seen:
        fail("所选 scheme 未引用所选 App target。")
    # This copied scheme is solely for testing; all its actions use the chosen
    # configuration so choosing Archive cannot silently select a formal config.
    for element in scheme.iter():
        if "buildConfiguration" in element.attrib:
            element.set("buildConfiguration", args.configuration)
    project_files[scheme_relative] = ET.tostring(scheme, encoding="utf-8", xml_declaration=True)
    project_files["project.pbxproj"] = plistlib.dumps(model, fmt=plistlib.FMT_XML, sort_keys=False)
    if load_pbxproj(project_files["project.pbxproj"]) != model:
        fail("生成的 project.pbxproj 未通过结构回读检查。")
    # Assert that only this configuration and projectDirPath changed.
    normalized = copy.deepcopy(model)
    normalized["objects"][config_id] = original_model["objects"][config_id]
    normalized["objects"][model["rootObject"]]["projectDirPath"] = original_model["objects"][model["rootObject"]].get("projectDirPath", "")
    if "projectDirPath" not in original_model["objects"][model["rootObject"]]:
        normalized["objects"][model["rootObject"]].pop("projectDirPath", None)
    if normalized != original_model:
        fail("内部校验失败：发生了目标配置之外的工程修改。")

    source_hashes = dict(project_hashes)
    source_hashes[str(info_path)] = digest(info_bytes)

    def verify_sources():
        current_project_hashes = {str(project / relative): digest(data)
                                  for relative, data in read_project_files(project).items()}
        if current_project_hashes != project_hashes:
            fail("准备期间源工程文件发生改变；请结束编辑后重试。")
        if not info_path.is_file() or digest(info_path.read_bytes()) != digest(info_bytes):
            fail("准备期间源 Info.plist 发生改变；请结束编辑后重试：" + str(info_path))

    generated = {project.name + "/" + relative: data for relative, data in project_files.items()}
    generated["Info-test.plist"] = plistlib.dumps(info, sort_keys=False)
    marker = {
        "owner": OWNER, "format": 1, "source_project": str(project),
        "target": args.target, "configuration": args.configuration, "scheme": args.scheme,
        "bundle_id": args.bundle_id, "version": args.version, "build": build,
        "source_sha256": source_hashes,
        "generated_sha256": {relative: digest(data) for relative, data in generated.items()},
    }
    generated[MARKER] = (json.dumps(marker, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output.parent / ("." + output.name + ".24ios-prepare.lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            fail("输出锁不是普通文件。")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("另一个准备流程正在使用这个输出目录。")
        previous_owner = lock.read()
        if previous_owner and previous_owner != OWNER + "\n":
            fail("输出锁路径已有其他内容，拒绝改写：" + str(lock_path))
        if not previous_owner:
            lock.write(OWNER + "\n")
            lock.flush()
        validate_managed_output(output, project)
        stage = Path(tempfile.mkdtemp(prefix="." + output.name + ".staging-", dir=str(output.parent)))
        backup = None
        try:
            for relative, data in generated.items():
                destination = stage / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            verify_sources()
            validate_managed_output(output, project)
            if output.exists():
                backup = Path(tempfile.mkdtemp(prefix="." + output.name + ".previous-", dir=str(output.parent)))
                backup.rmdir()
                output.rename(backup)
            try:
                stage.rename(output)
            except OSError:
                if backup is not None:
                    backup.rename(output)
                    backup = None
                raise
            try:
                verify_sources()
            except Exception:
                shutil.rmtree(output)
                if backup is not None:
                    backup.rename(output)
                    backup = None
                raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
            if backup is not None and backup.exists():
                shutil.rmtree(backup)
    return {
        "project": str(copied_project), "plist": str(copied_info),
        "scheme": args.scheme, "configuration": args.configuration,
        "bundle_id": args.bundle_id, "version": args.version, "build": build,
        "source_project": str(project), "source_unchanged": True,
        "untouched_targets": [value.get("name", key) for key, value in objects.items()
                              if isinstance(value, dict) and value.get("isa") == "PBXNativeTarget" and key != target_id],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="原始 .xcodeproj 目录")
    parser.add_argument("--output-dir", required=True, help="源工程之外的专用输出目录")
    parser.add_argument("--bundle-id", required=True, help="主 App 测试包名")
    parser.add_argument("--version", required=True, help="测试版本，例如 1.0.4")
    parser.add_argument("--build", help="可选构建号；省略时从源 Info.plist/target 获取")
    parser.add_argument("--target", default="Unity-iPhone")
    parser.add_argument("--configuration", default="Debug")
    parser.add_argument("--scheme", default="Unity-iPhone")
    try:
        result = prepare(parser.parse_args())
    except (PreparationError, OSError, ValueError, TypeError) as exc:
        print("准备失败：" + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
