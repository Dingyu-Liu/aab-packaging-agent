#!/usr/bin/env python3
"""Conservative Unity 6000/iOS 17 PAKit integration, using macOS plutil.

The generated host MUST be rendered for runtime.unity_profile=unity6000-ios17.
This helper never edits vendor binaries, embeds static libraries, signs or uploads.
It intentionally stops on native/nonmatching/previously integrated projects.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid

OWNER = "05ios-sdk-integration/v1"
PROFILE = "unity6000-ios17"
STATE = ".05ios-sdk-integration"
VERIFIED_UNITY_SCENE_MANIFEST = {
    "UIApplicationSupportsMultipleScenes": False,
    "UISceneConfigurations": {
        "UIWindowSceneSessionRoleApplication": [{
            "UISceneConfigurationName": "Default Configuration",
            "UISceneDelegateClassName": "UnityScene",
        }],
    },
}
HOST_NAMES = (
    "PAKitAppController.mm", "PAKitIntegration.h", "PAKitIntegration.m",
    "PAKitAdjustIntegration.h", "PAKitAdjustIntegration.m",
    "PAKitLoadingView.h", "PAKitLoadingView.m",
    "PAKitSafeAreaViewController.h", "PAKitSafeAreaViewController.m",
)
SYSTEM_FRAMEWORKS = (
    "Foundation", "UIKit", "WebKit", "AppTrackingTransparency", "AdSupport",
    "AdServices", "StoreKit", "Security", "SystemConfiguration", "CoreTelephony",
)


class IntegrationError(Exception):
    pass


def require(value, message):
    if not value:
        raise IntegrationError(message)


def digest(path: Path):
    """Content+symlink identity, not timestamps; handles static framework Versions links."""
    if not path.exists() and not path.is_symlink():
        return None
    h = hashlib.sha256()
    def visit(p, rel):
        h.update(rel.encode("utf-8") + b"\0")
        if p.is_symlink():
            h.update(b"L\0" + os.readlink(p).encode("utf-8") + b"\0")
        elif p.is_dir():
            h.update(b"D\0")
            for child in sorted(p.iterdir(), key=lambda v: v.name):
                visit(child, rel + "/" + child.name)
        else:
            h.update(b"F\0")
            with p.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(chunk)
    visit(path, "")
    return h.hexdigest()


def load_plist(path: Path):
    try:
        raw = path.read_bytes()
        if raw.startswith((b"<?xml", b"bplist")):
            return plistlib.loads(raw)
        return plistlib.loads(subprocess.check_output(
            ["/usr/bin/plutil", "-convert", "xml1", "-o", "-", str(path)],
            stderr=subprocess.PIPE))
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        raise IntegrationError(f"Cannot read property list {path}: {exc}") from exc


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def copy_node(source: Path, target: Path):
    if source.is_symlink():
        target.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, target, symlinks=True)
    else:
        shutil.copy2(source, target)


def remove_node(path: Path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def static_archive(path: Path):
    """Validate thin or fat ar libraries without executing or rewriting vendor code."""
    try:
        with path.open("rb") as binary:
            magic = binary.read(8)
            if magic == b"!<arch>\n":
                return True
            formats = {
                b"\xca\xfe\xba\xbe": (">", 20, "IIIII"),
                b"\xbe\xba\xfe\xca": ("<", 20, "IIIII"),
                b"\xca\xfe\xba\xbf": (">", 32, "IIQQII"),
                b"\xbf\xba\xfe\xca": ("<", 32, "IIQQII"),
            }
            if magic[:4] not in formats:
                return False
            endian, size, fmt = formats[magic[:4]]
            count = struct.unpack(endian + "I", magic[4:])[0]
            if count < 1 or count > 32:
                return False
            table = binary.read(size * count)
            if len(table) != size * count:
                return False
            for index in range(count):
                fields = struct.unpack(endian + fmt, table[index * size:(index + 1) * size])
                binary.seek(fields[2])
                if binary.read(8) != b"!<arch>\n":
                    return False
            return True
    except (OSError, struct.error):
        return False


def validate_xcframework(path: Path, name: str):
    require(path.is_dir() and path.name == name + ".xcframework",
            f"Expected a prepared {name}.xcframework directory: {path}")
    root = path.resolve()
    for item in path.rglob("*"):
        if item.is_symlink():
            require(item.exists() and item.resolve().is_relative_to(root),
                    f"Dangling or external framework symlink is unsupported: {item}")
    info = load_plist(path / "Info.plist")
    libraries = info.get("AvailableLibraries", [])
    require(libraries, f"No AvailableLibraries in {path}")
    ios_arm64 = False
    slices = []
    for lib in libraries:
        identifier, library_path = lib.get("LibraryIdentifier", ""), lib.get("LibraryPath", "")
        require(identifier and library_path, f"Malformed XCFramework slice: {lib}")
        item = path / identifier / library_path
        require(item.resolve().is_relative_to(root), f"XCFramework path escapes root: {item}")
        if library_path.endswith(".framework"):
            require(Path(library_path).stem == name, f"Host imports require module {name}: {item}")
            binary = item / name
        else:
            require(library_path.endswith(".a"), f"Unsupported library format: {item}")
            binary = item
        require(static_archive(binary), f"Only static ar XCFramework slices are supported: {binary}")
        arm = lib.get("SupportedPlatform") == "ios" and not lib.get("SupportedPlatformVariant") and "arm64" in lib.get("SupportedArchitectures", [])
        ios_arm64 = ios_arm64 or arm
        slices.append({"identifier": identifier, "platform": lib.get("SupportedPlatform"),
                       "variant": lib.get("SupportedPlatformVariant"),
                       "architectures": lib.get("SupportedArchitectures", []),
                       "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
    require(ios_arm64, f"No iOS device arm64 slice in {path}")
    return {"module": name, "tree_sha256": digest(path), "slices": slices}


def build_tokens(value):
    if value is None:
        return []
    if isinstance(value, list):
        require(all(isinstance(v, str) for v in value), f"Invalid build setting array: {value}")
        return list(value)
    require(isinstance(value, str), f"Unsupported build setting type: {value}")
    try:
        return shlex.split(value)
    except ValueError as exc:
        raise IntegrationError(f"Unparseable build setting: {value}") from exc


def add_setting_values(settings, key, values):
    current = build_tokens(settings.get(key))
    for value in values:
        if value not in current:
            current.append(value)
    settings[key] = current



def merge_privacy(existing, incoming):
    """Union supplied declarations; never manufacture reasons or vendor claims."""
    require(isinstance(existing, dict) and isinstance(incoming, dict), "Privacy manifest root must be a dictionary")
    result = copy.deepcopy(existing)
    for key, value in incoming.items():
        if key not in result:
            result[key] = copy.deepcopy(value)
            continue
        old = result[key]
        if key == "NSPrivacyTracking":
            require(type(old) is bool and type(value) is bool, "Invalid NSPrivacyTracking boolean")
            result[key] = old or value
        elif key == "NSPrivacyTrackingDomains":
            require(isinstance(old, list) and isinstance(value, list) and all(isinstance(item, str) for item in old + value), "Invalid tracking-domain array")
            result[key] = list(dict.fromkeys(old + value))
        elif key in ("NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes"):
            require(isinstance(old, list) and isinstance(value, list), f"Invalid privacy array: {key}")
            identity = "NSPrivacyAccessedAPIType" if key == "NSPrivacyAccessedAPITypes" else "NSPrivacyCollectedDataType"
            require(all(isinstance(item, dict) and isinstance(item.get(identity), str) for item in old + value), f"Invalid privacy records: {key}")
            records = {item[identity]: copy.deepcopy(item) for item in old}
            order = [item[identity] for item in old]
            require(len(order) == len(set(order)), f"Duplicate privacy identity requires review: {key}")
            for item in value:
                name = item[identity]
                if name not in records:
                    records[name] = copy.deepcopy(item)
                    order.append(name)
                    continue
                for field, supplied in item.items():
                    record = records[name]
                    if field not in record:
                        record[field] = copy.deepcopy(supplied)
                    elif isinstance(supplied, list) and isinstance(record[field], list):
                        require(all(isinstance(v, str) for v in supplied + record[field]), f"Invalid privacy string array: {field}")
                        record[field] = list(dict.fromkeys(record[field] + supplied))
                    elif type(supplied) is bool and type(record[field]) is bool:
                        record[field] = record[field] or supplied
                    else:
                        require(record[field] == supplied, f"Privacy declaration conflict requires review: {name}/{field}")
            result[key] = [records[name] for name in order]
        else:
            require(old == value, f"Privacy manifest key conflict requires review: {key}")
    return result


def objc_method_body(source, selector):
    """Extract the real method body, ignoring comments/string braces and decoys."""
    masked = re.sub(r'/\*.*?\*/|//[^\n]*|@?"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'',
                    lambda match: "".join("\n" if c == "\n" else " " for c in match[0]),
                    source, flags=re.S)
    signatures = list(re.finditer(r"(?m)^\s*-\s*\(\s*void\s*\)\s*" + re.escape(selector) + r"\s*:[^{;]+\{", masked))
    require(len(signatures) == 1, f"UnityScene must implement exactly one {selector}: lifecycle method")
    opening = signatures[0].end() - 1
    depth = 0
    for offset in range(opening, len(masked)):
        depth += (masked[offset] == "{") - (masked[offset] == "}")
        if depth == 0:
            return masked[opening + 1:offset]
    raise IntegrationError(f"Unbalanced UnityScene lifecycle method: {selector}")


class Planner:
    def __init__(self, config, generated_host: Path):
        self.config = config
        self.host = generated_host.resolve()
        self.project = Path(config["project"]["path"]).expanduser().resolve()
        require(self.project.suffix == ".xcodeproj" and self.project.is_dir(), "project.path must name an existing .xcodeproj directory")
        self.pbx = self.project / "project.pbxproj"
        self.original = load_plist(self.pbx)
        self.data = copy.deepcopy(self.original)
        self.objects = self.data["objects"]
        self.project_object = self.objects[self.data["rootObject"]]
        require(self.project_object.get("isa") == "PBXProject", "Invalid PBXProject root")
        directory = self.project_object.get("projectDirPath", "")
        require("$" not in directory, "Variable projectDirPath is unsupported")
        self.root = (self.project.parent / directory).resolve()
        require(self.root.is_dir(), f"Missing source root: {self.root}")
        self.state = self.root / STATE
        self.manifest_path = self.state / "manifest.json"
        self.previous = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else None
        if self.previous:
            require(self.previous.get("owner") == OWNER and self.previous.get("project") == str(self.project), "Integration manifest belongs to another project or tool version")
        self.managed_ids = set(self.previous.get("object_hashes", {})) if self.previous else set()
        self.managed_paths = self.previous.get("managed_paths", {}) if self.previous else {}
        self.writes = {}  # absolute destinations -> (bytes | input path)
        self.observed = {str(self.pbx): digest(self.pbx), str(self.manifest_path): digest(self.manifest_path)}
        self.generated_ids = set()
        self.privacy_sources = []
        self.vendor = []
        self.notes = []
        self.scene_validation = None

    def safe_destination(self, path):
        path = Path(path)
        require(path.resolve().is_relative_to(self.root), f"Destination escapes project source root: {path}")
        require(not path.is_symlink(), f"Managed destination itself cannot be a symlink: {path}")
        return path

    def queue(self, path, value):
        path = self.safe_destination(path)
        current = digest(path)
        self.observed[str(path)] = current
        same = path.is_file() and not isinstance(value, Path) and path.read_bytes() == value
        if isinstance(value, Path):
            self.observed[str(value)] = digest(value)
            same = current == digest(value)
        if not same:
            self.writes[path] = value

    def configs(self, target):
        collection = self.objects[target["buildConfigurationList"]]
        require(collection.get("isa") == "XCConfigurationList", "Missing target configuration list")
        result = []
        for object_id in collection.get("buildConfigurations", []):
            obj = self.objects[object_id]
            require(obj.get("isa") == "XCBuildConfiguration", "Invalid target configuration")
            require(not obj.get("baseConfigurationReference"), f"External xcconfig on {target['name']} / {obj.get('name')} requires manual review")
            result.append(obj)
        require(result, f"No build configurations for {target['name']}")
        return result

    def target(self, name, product_type):
        matches = [(k, v) for k, v in self.objects.items() if v.get("isa") == "PBXNativeTarget" and v.get("name") == name]
        require(len(matches) == 1, f"Expected exactly one native target named {name}")
        object_id, target = matches[0]
        require(target.get("productType") == product_type, f"Unexpected product type for target {name}")
        return object_id, target

    def phase(self, target, kind):
        matches = [self.objects[k] for k in target.get("buildPhases", []) if self.objects[k].get("isa") == kind]
        require(len(matches) == 1, f"Expected one {kind} on {target['name']}")
        return matches[0]

    def object(self, label, value):
        object_id = hashlib.sha256((OWNER + "\0" + label).encode()).hexdigest()[:24].upper()
        require(object_id not in self.objects or object_id in self.managed_ids,
                f"Generated Xcode object ID collides with existing object: {object_id}")
        self.objects[object_id] = value
        self.generated_ids.add(object_id)
        return object_id

    def add_reference(self, group, relative_path, filetype, tree="SOURCE_ROOT", reuse_system=False):
        if reuse_system:
            matches = [k for k, v in self.objects.items() if v.get("isa") == "PBXFileReference" and v.get("sourceTree") == tree and v.get("path") == relative_path]
            require(len(matches) <= 1, f"Duplicate system framework references require manual review: {relative_path}")
            if matches:
                if matches[0] in self.managed_ids:
                    self.generated_ids.add(matches[0])
                    if matches[0] not in group["children"]:
                        group["children"].append(matches[0])
                return matches[0]
        ref = self.object("file:" + tree + ":" + relative_path,
                          {"isa": "PBXFileReference", "lastKnownFileType": filetype,
                           "name": Path(relative_path).name, "path": relative_path, "sourceTree": tree})
        group["children"].append(ref)
        return ref

    def add_build_file(self, phase, ref, role, settings=None):
        matches = [k for k in phase.get("files", []) if self.objects[k].get("fileRef") == ref]
        require(len(matches) <= 1, f"Duplicate build entries require manual review: {ref}")
        if matches:
            if matches[0] in self.managed_ids:
                self.generated_ids.add(matches[0])
            return
        entry = {"isa": "PBXBuildFile", "fileRef": ref}
        if settings:
            entry["settings"] = settings
        object_id = self.object("build:" + role + ":" + ref, entry)
        phase.setdefault("files", []).append(object_id)

    def resolve_reference(self, object_id, trail=None):
        trail = set() if trail is None else trail
        require(object_id not in trail, "Cyclic PBXGroup structure")
        trail.add(object_id)
        obj = self.objects[object_id]
        tree, path = obj.get("sourceTree", "<group>"), obj.get("path", "")
        if tree == "SOURCE_ROOT":
            return self.root / path
        if tree == "<absolute>":
            return Path(path)
        if tree != "<group>":
            return None
        parents = [k for k, v in self.objects.items() if v.get("isa") in ("PBXGroup", "PBXVariantGroup") and object_id in v.get("children", [])]
        if object_id == self.project_object["mainGroup"]:
            return self.root / path
        require(len(parents) == 1, f"Cannot uniquely resolve source path for Xcode object {object_id}")
        parent = self.resolve_reference(parents[0], trail)
        return parent / path if parent is not None else None

    def preflight(self):
        cfg = self.config
        require(cfg.get("runtime", {}).get("unity_profile") == PROFILE,
                f"Only explicitly selected runtime.unity_profile={PROFILE} is supported")
        require(type(cfg.get("ui", {}).get("startup_loading")) is bool and type(cfg.get("ui", {}).get("safe_area")) is bool, "ui.startup_loading and ui.safe_area must be explicit booleans")
        app = cfg.get("app", {})
        require(re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", app.get("bundle_id", "")), "Invalid app.bundle_id")
        require(re.fullmatch(r"\d+\.\d+\.\d+", app.get("version", "")), "app.version must be an explicit x.y.z version")
        require(re.fullmatch(r"\d+(?:\.\d+){0,2}", str(app.get("build", ""))), "Invalid app.build")
        minimum = str(cfg.get("runtime", {}).get("minimum_ios_version", "17.0"))
        require(re.fullmatch(r"\d+\.\d+(?:\.\d+)?", minimum), "Invalid runtime.minimum_ios_version")
        require(tuple(map(int, minimum.split("."))) >= (17, 0), "This host profile requires iOS 17 or newer")
        self.minimum = minimum
        self.app_id, self.app_target = self.target(cfg["project"].get("target", "Unity-iPhone"), "com.apple.product-type.application")
        self.framework_id, self.framework_target = self.target(cfg["project"].get("framework_target", "UnityFramework"), "com.apple.product-type.framework")
        self.app_configs = self.configs(self.app_target)
        self.framework_configs = self.configs(self.framework_target)
        self.framework_phase = self.phase(self.framework_target, "PBXFrameworksBuildPhase")
        self.framework_resources_phase = self.phase(self.framework_target, "PBXResourcesBuildPhase")
        self.sources_phase = self.phase(self.framework_target, "PBXSourcesBuildPhase")
        self.resources_phase = self.phase(self.app_target, "PBXResourcesBuildPhase")
        project_configs = {v["name"]: v.get("buildSettings", {}) for v in self.configs(self.project_object_with_name())}
        self.info_paths = set()
        for config in self.app_configs + self.framework_configs:
            settings = config.setdefault("buildSettings", {})
            effective = dict(project_configs.get(config["name"], {})); effective.update(settings)
            require(effective.get("GENERATE_INFOPLIST_FILE", "NO") not in ("YES", True), "GENERATE_INFOPLIST_FILE is unsupported; provide a real App Info.plist")
            if config in self.framework_configs:
                require(str(effective.get("UNITY_RUNTIME_VERSION", "")).startswith("6000."), f"Unverified Unity runtime in {config['name']}; this template requires Unity 6000")
            sdkroot = effective.get("SDKROOT", "iphoneos")
            require(sdkroot == "iphoneos", f"Non-iOS SDKROOT is unsupported: {sdkroot}")
            deploy = str(effective.get("IPHONEOS_DEPLOYMENT_TARGET", ""))
            require(re.fullmatch(r"\d+(?:\.\d+){0,2}", deploy) and tuple(map(int, deploy.split("."))) >= (17,), f"Existing deployment target must be >=17 before selecting this host profile: {deploy}")
            for key in ("INFOPLIST_FILE", "GENERATE_INFOPLIST_FILE", "PRODUCT_BUNDLE_IDENTIFIER", "MARKETING_VERSION", "CURRENT_PROJECT_VERSION"):
                require(not any(k.startswith(key + "[") for k in settings), f"Conditional {key} build setting requires manual review")
            if config in self.app_configs:
                info = settings.get("INFOPLIST_FILE", effective.get("INFOPLIST_FILE"))
                require(isinstance(info, str) and info, f"No explicit App Info.plist in {config['name']}")
                info = info.strip('"').replace("$(SRCROOT)", str(self.root)).replace("$(PROJECT_DIR)", str(self.root))
                require("$" not in info, "Variable INFOPLIST_FILE beyond SRCROOT/PROJECT_DIR is unsupported")
                info_path = (self.root / info).resolve()
                require(info_path.is_relative_to(self.root) and info_path.is_file(), f"Missing or external App Info.plist: {info_path}")
                self.info_paths.add(info_path)
        required_unity = {
            "Classes/UnityAppController.h": ("_rootView", "_unityView", "IMPL_APP_CONTROLLER_SUBCLASS"),
            "Classes/UI/UnityAppController+ViewHandling.h": ("willStartWithViewController",),
            "Classes/UI/UnityAppController+ViewHandling.mm": ("_rootController.view = _rootView = _unityView", "willStartWithViewController"),
            "Classes/UI/UnityViewControllerBase+iOS.h": ("UnityDefaultViewController",),
        }
        for relative, markers in required_unity.items():
            path = self.root / relative
            require(path.is_file(), f"Unity profile file is absent: {path}")
            content = path.read_text(errors="replace")
            require(all(mark in content for mark in markers), f"Unity host API differs from the verified profile: {path}")
        if self.previous:
            for object_id, expected in self.previous["object_hashes"].items():
                require(object_id in self.objects and hashlib.sha256(json_bytes(self.objects[object_id])).hexdigest() == expected,
                        f"Managed Xcode object was edited outside the helper: {object_id}")
            for relative, expected in self.managed_paths.items():
                path = self.safe_destination(self.root / relative)
                require(digest(path) == expected, f"Managed file changed outside the helper; review before overwrite: {path}")
        host_dir = self.host / "Classes" / "PAKit"
        actual_names = {p.name for p in host_dir.iterdir()} if host_dir.is_dir() else set()
        require(actual_names == set(HOST_NAMES), f"Generated host must contain exactly the verified 9 files: {host_dir}")
        for name in HOST_NAMES:
            source = host_dir / name
            require(source.is_file() and not source.is_symlink(), f"Invalid generated source: {source}")
            require(not re.search(r"__[A-Z][A-Z0-9_]+__", source.read_text()), f"Unrendered placeholder remains in {source}")
        generated_classes = set()
        for name in HOST_NAMES:
            generated_classes.update(re.findall(r"@(?:interface|implementation)\s+(\w+)", (host_dir / name).read_text()))
        controller = (host_dir / "PAKitAppController.mm").read_text()
        require(len(re.findall(r"(?m)^\s*IMPL_APP_CONTROLLER_SUBCLASS\s*\(", controller)) == 1, "Generated host must register exactly one Unity AppController subclass")
        self.privacy_path = self.root / "UnityFramework/PrivacyInfo.xcprivacy"
        require(self.privacy_path.is_file(), "Existing UnityFramework/PrivacyInfo.xcprivacy is required; do not invent a vendor privacy manifest")
        privacy_build_refs = [self.objects[self.objects[k]["fileRef"]] for k in self.framework_resources_phase.get("files", []) if self.objects[k].get("fileRef")]
        require(any(Path(obj.get("path", "")).name == "PrivacyInfo.xcprivacy" for obj in privacy_build_refs), "Unity privacy manifest is not included in UnityFramework Resources")
        self.observed[str(self.privacy_path)] = digest(self.privacy_path)
        managed_relatives = set(self.managed_paths)
        reserved_basenames = set(HOST_NAMES) | {"PAKit.xcframework", "AdjustSdk.xcframework", "AdjustSigSdk.xcframework"}
        for object_id, obj in self.objects.items():
            if obj.get("isa") == "PBXFileReference" and object_id not in self.managed_ids:
                basename = Path(obj.get("path", "")).name
                require(basename not in reserved_basenames, f"Pre-existing PAKit/Adjust reference needs explicit migration: {basename}")
        for obj in list(self.objects.values()):
            if obj.get("isa") != "PBXSourcesBuildPhase":
                continue
            for build_id in obj.get("files", []):
                ref = self.objects[build_id].get("fileRef")
                if not ref or ref in self.managed_ids:
                    continue
                path = self.resolve_reference(ref)
                require(path is not None and path.is_file(), f"Cannot inspect compiled source for AppController conflict: {path or ref}")
                if path.suffix not in (".m", ".mm", ".c", ".cpp", ".cc"):
                    continue
                content = path.read_text(errors="replace")
                require(not re.search(r"(?m)^\s*IMPL_APP_CONTROLLER_SUBCLASS\s*\(", content), f"Existing custom AppController must be merged manually: {path}")
                declared = set(re.findall(r"@(?:interface|implementation)\s+(\w+)", content))
                require(not (declared & generated_classes), f"Generated Objective-C class namespace already exists in {path}: {sorted(declared & generated_classes)}")
        desired_paths = ["Classes/PAKit/" + name for name in HOST_NAMES]
        desired_paths += ["Libraries/PAKit/PAKit.xcframework", "Libraries/Adjust/AdjustSdk.xcframework"]
        if cfg.get("adjust", {}).get("signature_xcframework"):
            desired_paths.append("Libraries/Adjust/AdjustSigSdk.xcframework")
        for relative in desired_paths:
            path = self.safe_destination(self.root / relative)
            require(relative in managed_relatives or not path.exists(), f"Destination already exists without this helper's ownership manifest: {path}")
        require(not self.previous or self.previous.get("profile") == PROFILE, "Managed integration uses a different host profile")
        scheme = cfg["project"].get("scheme", "Unity-iPhone")
        scheme_path = self.project / "xcshareddata" / "xcschemes" / (scheme + ".xcscheme")
        require(scheme_path.is_file(), f"A shared scheme is required: {scheme_path}")
        import xml.etree.ElementTree as ET
        try:
            scheme_xml = ET.parse(scheme_path)
        except ET.ParseError as exc:
            raise IntegrationError(f"Invalid shared scheme: {scheme_path}") from exc
        refs = scheme_xml.findall(".//BuildActionEntry/BuildableReference")
        require(any(r.attrib.get("BlueprintIdentifier") == self.app_id for r in refs), f"Shared scheme {scheme} does not build the selected App target")
        self.notes.append("Restricted to the verified Unity 6000/iOS>=17 export; native Apps and custom AppController merging are manual.")

    def validate_scene_manifest(self, manifest):
        require(isinstance(manifest, dict) and
                type(manifest.get("UIApplicationSupportsMultipleScenes")) is bool and
                manifest == VERIFIED_UNITY_SCENE_MANIFEST,
                "Only the verified single-window UnityScene manifest is supported; custom Scene/multiple scenes require manual adaptation")
        if self.scene_validation:
            return
        source = self.root / "Classes/UI/UnityScene.mm"
        header = self.root / "Classes/UI/UnityScene.h"
        require(source.is_file() and header.is_file(), "The verified UnityScene lifecycle source/header is missing")
        body = source.read_text(errors="replace")
        header_body = header.read_text(errors="replace")
        require(re.search(r"@interface\s+UnityScene\s*:\s*UIResponder\s*<\s*UIWindowSceneDelegate\s*>", header_body),
                "UnityScene header no longer uses the verified UIWindowSceneDelegate interface")
        require(re.search(r"@implementation\s+UnityScene\b", body), "UnityScene source implements another class")
        compiled = []
        for build_id in self.sources_phase.get("files", []):
            ref = self.objects[build_id].get("fileRef")
            if ref:
                path = self.resolve_reference(ref)
                if path is not None:
                    compiled.append(path.resolve())
        require(compiled.count(source.resolve()) == 1, "UnityScene.mm must be compiled exactly once into UnityFramework Sources")
        callbacks = {
            "sceneDidBecomeActive": "applicationDidBecomeActive",
            "sceneWillResignActive": "applicationWillResignActive",
            "sceneWillEnterForeground": "applicationWillEnterForeground",
            "sceneDidEnterBackground": "applicationDidEnterBackground",
        }
        for scene_selector, application_selector in callbacks.items():
            method = objc_method_body(body, scene_selector)
            require(re.search(r"auto\s+appController\s*=\s*GetAppController\s*\(\s*\)\s*;", method) and
                    re.search(r"\[\s*appController\s+" + application_selector + r"\s*:\s*UIApplication\s*\.\s*sharedApplication\s*\]\s*;", method),
                    f"UnityScene {scene_selector}: no longer forwards lifecycle to GetAppController()/{application_selector}:")
            if scene_selector == "sceneWillEnterForeground":
                require(re.search(r"\[\s*appController\s+initUnityWithScene\s*:\s*windowScene\s*\]\s*;", method),
                        "UnityScene foreground no longer initializes the AppController with its windowScene")
        for path in (source, header):
            self.observed[str(path)] = digest(path)
        self.scene_validation = {
            "type": "verified-single-window-UnityScene",
            "manifest_preserved": True,
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "header_sha256": hashlib.sha256(header.read_bytes()).hexdigest(),
        }
        self.notes.append("Accepted the original single-window UnityScene manifest after checking source forwarding to GetAppController; preserved its values unchanged.")

    def project_object_with_name(self):
        result = dict(self.project_object)
        result["name"] = "PBXProject"
        return result

    def plan(self):
        self.preflight()
        group_id = self.object("group", {"isa": "PBXGroup", "name": "05IOSSDK Integration", "sourceTree": "<group>", "children": []})
        group = self.objects[group_id]
        root_group = self.objects[self.project_object["mainGroup"]]
        require(root_group.get("isa") == "PBXGroup", "Unexpected root group type")
        if group_id not in root_group.setdefault("children", []):
            root_group["children"].append(group_id)
        for name in HOST_NAMES:
            relative = "Classes/PAKit/" + name
            source = self.host / relative
            self.queue(self.root / relative, source)
            filetype = "sourcecode.c.h" if name.endswith(".h") else "sourcecode.cpp.objcpp" if name.endswith(".mm") else "sourcecode.c.objc"
            ref = self.add_reference(group, relative, filetype)
            if not name.endswith(".h"):
                self.add_build_file(self.sources_phase, ref, "host", {"COMPILER_FLAGS": "-fobjc-arc"})
        vendor_inputs = [(self.config.get("sdk", {}).get("xcframework"), "PAKit", "PAKit"),
                         (self.config.get("adjust", {}).get("sdk_xcframework"), "AdjustSdk", "Adjust")]
        signature = self.config.get("adjust", {}).get("signature_xcframework")
        if signature:
            vendor_inputs.append((signature, "AdjustSigSdk", "Adjust"))
        # Removing an existing signature binary is intentionally not automatic.
        if self.previous:
            old_sig = "Libraries/Adjust/AdjustSigSdk.xcframework" in self.managed_paths
            require(old_sig == bool(signature), "Changing the Adjust signature-library topology requires a fresh reviewed integration")
        for input_path, name, subdir in vendor_inputs:
            require(input_path, f"Missing prepared SDK input for {name}")
            source = Path(input_path).expanduser().resolve()
            self.vendor.append(validate_xcframework(source, name))
            privacy_key = "signature_privacy_manifest" if name == "AdjustSigSdk" else "privacy_manifest"
            section = self.config["sdk"] if name == "PAKit" else self.config["adjust"]
            explicit_privacy = section.get(privacy_key)
            candidates = [Path(explicit_privacy).expanduser().resolve()] if explicit_privacy else sorted(source.rglob("PrivacyInfo.xcprivacy"))
            if not candidates and name == "AdjustSdk":
                adjacent = source.parent / "Adjust-PrivacyInfo.xcprivacy"
                if adjacent.is_file():
                    candidates = [adjacent]
            if not candidates and name == "AdjustSigSdk":
                adjacent = source.parent / "AdjustSignature-PrivacyInfo.xcprivacy"
                if adjacent.is_file():
                    candidates = [adjacent]
            require(candidates or name == "PAKit", f"{name} has no supplied privacy manifest; provide adjust.{privacy_key} from the same official SDK release")
            if not candidates:
                self.notes.append("PAKit vendor supplied no privacy manifest; preserve that fact and verify release privacy declarations with the vendor rather than fabricate one.")
            for privacy_source in candidates:
                require(privacy_source.is_file(), f"Supplied vendor privacy manifest is absent: {privacy_source}")
                self.privacy_sources.append(privacy_source)
                self.observed[str(privacy_source)] = digest(privacy_source)
            relative = f"Libraries/{subdir}/{name}.xcframework"
            self.queue(self.root / relative, source)
            ref = self.add_reference(group, relative, "wrapper.xcframework")
            self.add_build_file(self.framework_phase, ref, "framework")
        for name in SYSTEM_FRAMEWORKS:
            ref = self.add_reference(group, f"System/Library/Frameworks/{name}.framework", "wrapper.framework", "SDKROOT", True)
            self.add_build_file(self.framework_phase, ref, "framework")
        for config in self.framework_configs:
            settings = config["buildSettings"]
            add_setting_values(settings, "OTHER_LDFLAGS", ["$(inherited)", "-ObjC"])
            add_setting_values(settings, "HEADER_SEARCH_PATHS", ["$(inherited)", "$(PROJECT_DIR)/Classes/PAKit"])
            add_setting_values(settings, "FRAMEWORK_SEARCH_PATHS", ["$(inherited)"])
        for config in self.app_configs:
            settings = config["buildSettings"]
            settings["PRODUCT_BUNDLE_IDENTIFIER"] = self.config["app"]["bundle_id"]
            settings["MARKETING_VERSION"] = self.config["app"]["version"]
            settings["CURRENT_PROJECT_VERSION"] = str(self.config["app"]["build"])
        for config in self.app_configs + self.framework_configs:
            settings = config["buildSettings"]
            current = str(settings.get("IPHONEOS_DEPLOYMENT_TARGET", "17.0"))
            if tuple(map(int, current.split("."))) < tuple(map(int, self.minimum.split("."))):
                settings["IPHONEOS_DEPLOYMENT_TARGET"] = self.minimum
        current_privacy = load_plist(self.privacy_path)
        merged_privacy = copy.deepcopy(current_privacy)
        for source in self.privacy_sources:
            merged_privacy = merge_privacy(merged_privacy, load_plist(source))
        if merged_privacy != current_privacy:
            self.queue(self.privacy_path, plistlib.dumps(merged_privacy, sort_keys=False))
        fragment = load_plist(self.host / "Info.plist.fragment")
        for key, expected in (("PAKitStartupLoadingEnabled", self.config["ui"]["startup_loading"]),
                              ("PAKitSafeAreaEnabled", self.config["ui"]["safe_area"])):
            require(fragment.get(key) is expected, f"Rendered host fragment does not match configuration: {key}")
        require(isinstance(fragment, dict) and isinstance(fragment.get("NSUserTrackingUsageDescription"), str) and fragment["NSUserTrackingUsageDescription"].strip(), "Rendered Info.plist.fragment must supply a tracking usage description")
        require(fragment.get("PAKitIntegrationEnabled") is True, "Rendered fragment must explicitly enable PAKit integration")
        require(not any(key in fragment for key in ("CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "UIApplicationSceneManifest")), "Host fragment cannot replace bundle, version or scene identity")
        for path in self.info_paths:
            info = load_plist(path)
            if "UIApplicationSceneManifest" in info:
                self.validate_scene_manifest(info["UIApplicationSceneManifest"])
            info.update(fragment)
            info["CFBundleIdentifier"] = "$(PRODUCT_BUNDLE_IDENTIFIER)"
            info["CFBundleShortVersionString"] = self.config["app"]["version"]
            info["CFBundleVersion"] = str(self.config["app"]["build"])
            if self.config["ui"]["startup_loading"]:
                info["UILaunchStoryboardName"] = "PAKitLaunchScreen-iPhone"
                info["UILaunchStoryboardName~ipad"] = "PAKitLaunchScreen-iPad"
                for device in ("iphone", "ipod"):
                    key = "UILaunchStoryboardName~" + device
                    if key in info:
                        info[key] = "PAKitLaunchScreen-iPhone"
            self.queue(path, plistlib.dumps(info, sort_keys=False))
        if self.previous:
            require(self.previous["ui_startup_loading"] == self.config["ui"]["startup_loading"], "Changing launch-screen ownership requires manual migration; do not silently overwrite a designer's launch resources")
        if self.config["ui"]["startup_loading"]:
            for device in ("iPhone", "iPad"):
                input_path = self.host / f"LaunchScreen-{device}.storyboard"
                require(input_path.is_file(), f"Missing rendered launch screen: {input_path}")
                relative = f"Classes/PAKit/PAKitLaunchScreen-{device}.storyboard"
                require(relative in self.managed_paths or not (self.root / relative).exists(), f"Pre-existing launch storyboard requires manual review: {relative}")
                self.queue(self.root / relative, input_path)
                ref = self.add_reference(group, relative, "file.storyboard")
                self.add_build_file(self.resources_phase, ref, "launch")
        # Every SDK build file is linked to UnityFramework, never to CopyFiles/Embed.
        managed_vendor_refs = {k for k in self.generated_ids if self.objects[k].get("isa") == "PBXFileReference" and self.objects[k].get("lastKnownFileType") == "wrapper.xcframework"}
        for obj in self.objects.values():
            if obj.get("isa") == "PBXCopyFilesBuildPhase":
                require(not any(self.objects[k].get("fileRef") in managed_vendor_refs for k in obj.get("files", [])), "Static SDK must not appear in an Embed/CopyFiles phase")
        stale = self.managed_ids - self.generated_ids
        require(not stale, f"Managed object topology changed; explicit migration required: {sorted(stale)}")
        if self.data != self.original:
            self.queue(self.pbx, plistlib.dumps(self.data, sort_keys=False))
        managed_paths = {}
        for name in HOST_NAMES:
            relative = "Classes/PAKit/" + name
            managed_paths[relative] = digest(self.host / relative)
        for input_path, name, subdir in vendor_inputs:
            managed_paths[f"Libraries/{subdir}/{name}.xcframework"] = digest(Path(input_path).expanduser().resolve())
        if self.config["ui"]["startup_loading"]:
            for device in ("iPhone", "iPad"):
                managed_paths[f"Classes/PAKit/PAKitLaunchScreen-{device}.storyboard"] = digest(self.host / f"LaunchScreen-{device}.storyboard")
        manifest = {"owner": OWNER, "project": str(self.project), "profile": PROFILE,
                    "ui_startup_loading": self.config["ui"]["startup_loading"],
                    "managed_paths": managed_paths,
                    "object_hashes": {key: hashlib.sha256(json_bytes(self.objects[key])).hexdigest() for key in sorted(self.generated_ids)}}
        self.queue(self.manifest_path, json_bytes(manifest))
        return self

    def apply(self):
        if not self.writes:
            return None
        # Fully stage every input before touching project files.
        with tempfile.TemporaryDirectory(prefix="05ios-sdk-stage-") as directory:
            stage = Path(directory)
            staged = []
            for index, (destination, value) in enumerate(self.writes.items()):
                prepared = stage / str(index)
                if isinstance(value, Path):
                    copy_node(value, prepared)
                else:
                    prepared.write_bytes(value)
                staged.append((destination, prepared))
            for path, expected in self.observed.items():
                require(digest(Path(path)) == expected, f"Project changed during planning; retry after reviewing: {path}")
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = self.state / "backups" / (stamp + "-" + uuid.uuid4().hex[:8])
            backup.mkdir(parents=True)
            recovery = {"owner": OWNER, "project": str(self.project), "entries": []}
            for index, (destination, _) in enumerate(staged):
                old = digest(destination)
                entry = {"destination": str(destination), "existed": old is not None, "sha256": old}
                if old is not None:
                    saved = backup / str(index)
                    copy_node(destination, saved)
                    entry["backup"] = str(saved)
                recovery["entries"].append(entry)
            (backup / "rollback.json").write_bytes(json_bytes(recovery))
            created_parents = set()
            try:
                for destination, prepared in staged:
                    ancestor = destination.parent
                    while not ancestor.exists():
                        created_parents.add(ancestor)
                        ancestor = ancestor.parent
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    remove_node(destination)
                    # copy2/copytree works when TMPDIR and project are different volumes.
                    copy_node(prepared, destination)
            except BaseException as exc:
                for entry in reversed(recovery["entries"]):
                    destination = Path(entry["destination"])
                    remove_node(destination)
                    if entry["existed"]:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        copy_node(Path(entry["backup"]), destination)
                for parent in sorted(created_parents, key=lambda p: len(p.parts), reverse=True):
                    if parent.is_dir() and not any(parent.iterdir()):
                        parent.rmdir()
                if isinstance(exc, Exception):
                    raise IntegrationError(f"Project write failed and was automatically restored; backup: {backup}; cause: {exc}") from exc
                raise
            return str(backup)

    def report(self, check_only, backup=None):
        return {"status": "planned" if check_only else "applied" if self.writes else "unchanged",
                "profile": PROFILE, "project": str(self.project), "source_root": str(self.root),
                "app_target": self.app_target["name"], "framework_target": self.framework_target["name"],
                "app": self.config["app"], "changed_paths": [str(p) for p in self.writes],
                "backup": backup, "vendor_integrity": self.vendor, "scene_validation": self.scene_validation, "privacy_manifests_merged": [str(p) for p in self.privacy_sources], "notes": self.notes,
                "validation_remaining": ["xcodebuild arm64", "signed physical-device test", "ATT/SDK/Adjust callback verification"],
                "build_and_device_validation_performed": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--generated-host", type=Path, required=True)
    parser.add_argument("--output-report", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args(argv)
    report = {}
    try:
        config = json.loads(args.config.read_text())
        project_identity = str(Path(config["project"]["path"]).expanduser().resolve())
        lock_path = Path(tempfile.gettempdir()) / ("05ios-sdk-" + hashlib.sha256(project_identity.encode()).hexdigest() + ".lock")
        with lock_path.open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise IntegrationError("Another integration operation is using this project") from exc
            planner = Planner(config, args.generated_host).plan()
            backup = None if args.check_only else planner.apply()
            report = planner.report(args.check_only, backup)
        status = 0
    except (IntegrationError, OSError, ValueError, KeyError, TypeError) as exc:
        report = {"status": "blocked", "error": str(exc), "build_and_device_validation_performed": False}
        print(f"Integration stopped: {exc}", file=sys.stderr)
        status = 2
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_bytes(json_bytes(report))
    print(json.dumps({"status": report["status"], "report": str(args.output_report.resolve())}, ensure_ascii=False))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
