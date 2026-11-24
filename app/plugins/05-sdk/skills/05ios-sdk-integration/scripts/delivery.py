#!/usr/bin/env python3
"""Generate a movable test installer and optionally install an isolated iOS test build.

Public: delivery.py --config parameters.json --output-dir /absolute/delivery [--script-only]
The generated .command rechecks devices when run. Never patches the source project.
Only Python's standard library and Xcode command line tools are required on macOS.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from types import SimpleNamespace

OWNER = "05ios-sdk-integration.delivery"
MARKER = ".05ios-delivery.json"
COMMAND = "安装iOS测试包.command"
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){0,2}\Z")
BUNDLE = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z")
VARIABLE = re.compile(r"\$\(([^)]+)\)|\$\{([^}]+)\}")


class DeliveryError(Exception):
    def __init__(self, reason, message, pending=False):
        super().__init__(message)
        self.reason, self.pending = reason, pending


def fail(reason, message, pending=False):
    raise DeliveryError(reason, message, pending)


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_config(path):
    """Persist only the public contract; unrelated credentials are never copied."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail("invalid_config", "参数文件根对象必须是 JSON 字典。")
    fields = {
        "project": ("path", "target", "framework_target", "scheme"), "app": ("bundle_id", "version", "build", "tracking_usage_description"),
        "sdk": ("app_store_id", "expected_config_endpoint"), "adjust": ("environment",),
        "test": ("bundle_id", "version", "build", "team_id", "device_id"),
        "xcode": ("developer_dir",),
        "ui": ("startup_loading", "safe_area", "initial_page_timeout_seconds"),
    }
    config = {}
    for section, keys in fields.items():
        value = raw.get(section, {})
        if not isinstance(value, dict):
            fail("invalid_config", section + " 必须为字典。")
        config[section] = {k: value[k] for k in keys if k in value}
    config["project"].setdefault("target", "Unity-iPhone")
    config["project"].setdefault("scheme", "Unity-iPhone")
    config["project"].setdefault("framework_target", "UnityFramework")
    for section, keys in {
        "project": ("path", "target", "scheme"), "app": ("bundle_id", "version", "build", "tracking_usage_description"),
        "sdk": ("app_store_id", "expected_config_endpoint"), "adjust": ("environment",),
        "test": ("bundle_id",),
    }.items():
        for key in keys:
            if not isinstance(config[section].get(key), str) or not config[section][key].strip():
                fail("invalid_config", section + "." + key + " 必须为非空字符串。")
    for key in ("version", "build"):
        config["test"].setdefault(key, config["app"][key])
        for section in ("app", "test"):
            if not isinstance(config[section][key], str) or not VERSION.fullmatch(config[section][key]):
                fail("invalid_config", section + "." + key + " 必须为 1～3 段数字字符串。")
    for section in ("app", "test"):
        if not BUNDLE.fullmatch(config[section]["bundle_id"]):
            fail("invalid_config", section + ".bundle_id 不是有效包名。")
    if config["app"]["bundle_id"] == config["test"]["bundle_id"]:
        fail("invalid_config", "测试包名必须与正式包名不同。")
    if config["adjust"]["environment"].lower() not in ("production", "sandbox"):
        fail("invalid_config", "adjust.environment 必须为 production 或 sandbox。")
    if not config["sdk"]["app_store_id"].isdigit():
        fail("invalid_config", "sdk.app_store_id 必须是 App Store 数字 ID 字符串。")
    from urllib.parse import urlsplit
    endpoint = urlsplit(config["sdk"]["expected_config_endpoint"])
    if endpoint.scheme != "https" or not endpoint.netloc or endpoint.username or endpoint.password:
        fail("invalid_config", "sdk.expected_config_endpoint 必须为不含账号密码的 HTTPS URL。")
    for section, key in (("test", "device_id"), ("test", "team_id"), ("xcode", "developer_dir")):
        if config[section].get(key) == "":
            config[section].pop(key)
        elif key in config[section] and not isinstance(config[section][key], str):
            fail("invalid_config", section + "." + key + " 必须为字符串。")
    if "tracking_usage_description" in config["app"]:
        value = config["app"]["tracking_usage_description"]
        if not isinstance(value, str) or not value.strip():
            fail("invalid_config", "app.tracking_usage_description 必须为非空字符串。")
    for key in ("startup_loading", "safe_area"):
        if key in config["ui"] and type(config["ui"][key]) is not bool:
            fail("invalid_config", "ui." + key + " 必须为布尔值。")
    if "initial_page_timeout_seconds" in config["ui"]:
        value = config["ui"]["initial_page_timeout_seconds"]
        if type(value) not in (int, float) or not 5 <= value <= 300:
            fail("invalid_config", "ui.initial_page_timeout_seconds 必须在5至300之间。")
    project = Path(config["project"]["path"]).expanduser()
    project = (project if project.is_absolute() else path.parent / project).resolve()
    if project.suffix != ".xcodeproj" or not (project / "project.pbxproj").is_file():
        fail("invalid_config", "project.path 必须指向存在的 .xcodeproj。")
    for key in ("target", "scheme"):
        if "/" in config["project"][key] or "\x00" in config["project"][key]:
            fail("invalid_config", "project." + key + " 不能包含路径或 NUL。")
    config["project"]["path"] = str(project)
    return config


def emit_bundle(config, output):
    """The runner and preparation helper travel with .command, never with a skill path."""
    output = output.resolve()
    source = Path(config["project"]["path"]).parent
    if output == source or source in output.parents or output in source.parents:
        fail("unsafe_output", "交付目录必须放在原始工程目录之外，且不能包含原始工程。")
    files = {
        COMMAND: ('''#!/bin/zsh
set -u
SCRIPT_DIR="${0:A:h}"
/usr/bin/python3 "$SCRIPT_DIR/resources/delivery.py" --config "$SCRIPT_DIR/resources/config.json" --output-dir "$SCRIPT_DIR" --execute "$@"
DELIVERY_EXIT=$?
if [[ -t 0 && $# -eq 0 ]]; then
    read "?按 Enter 关闭窗口…"
fi
exit "$DELIVERY_EXIT"
''').encode(),
        "resources/delivery.py": Path(__file__).read_bytes(),
        "resources/prepare_test_project.py": Path(__file__).with_name("prepare_test_project.py").read_bytes(),
        "resources/config.json": (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode(),
        "使用说明.txt": ("保留整个文件夹，再双击「" + COMMAND + "」。脚本会重新探测设备。\n"
                       "无设备、锁屏或多设备未指定时不会构建安装；原因见 status.json 和 runs/ 日志。\n"
                       "resources 含全部 runner 代码，无需安装本 skill。源 Xcode 工程仍须存在；移动工程后修改 resources/config.json 的 project.path。\n"
                       "测试包名与 SDK/Adjust 环境是独立参数；临时包名可能影响服务端开关结果。\n"
                       "脚本只在独立测试工程中改包名与版本，不上传 App Store，不保存证书或私钥。\n").encode(),
    }
    if output.exists() and any(output.iterdir()):
        marker = output / MARKER
        if not marker.is_file():
            fail("unsafe_output", "交付目录非空且不属于本工具，请选择新的空目录。")
        previous = json.loads(marker.read_text())
        if previous.get("owner") != OWNER:
            fail("unsafe_output", "交付目录管理标记不匹配。")
        for relative, expected in previous.get("files", {}).items():
            path = output / relative
            if path.is_symlink() or not path.is_file() or sha(path.read_bytes()) != expected:
                fail("edited_delivery", "交付文件已被修改，拒绝覆盖：" + relative)
    for relative, data in files.items():
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            fail("unsafe_output", "交付路径为软链接：" + str(destination))
        destination.write_bytes(data)
    (output / COMMAND).chmod(0o755)
    write_json(output / MARKER, {"owner": OWNER, "files": {k: sha(v) for k, v in files.items()}})
    return output / COMMAND


class SubprocessBackend:
    """Only this adapter touches processes. Tests replace it with a fixture backend."""
    def run(self, args, *, log, env, timeout):
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("w", encoding="utf-8") as stream:
            process = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT, env=env,
                                       start_new_session=True)
            deadline = time.monotonic() + timeout
            while True:
                try:
                    return process.wait(timeout=max(0.1, min(20, deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                        raise TimeoutError("命令超过 {} 秒，详见 {}".format(timeout, log))
                    print("[{}] 仍在执行，日志：{}".format(now().isoformat(timespec="seconds"), log), flush=True)


class Runner:
    def __init__(self, config, output, backend=None, prepare=None):
        self.config, self.output = config, output
        self.backend = backend or SubprocessBackend()
        self.prepare = prepare or self.load_prepare()
        self.run_dir = output / "runs" / now().strftime("%Y%m%dT%H%M%S.%fZ")
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.env = dict(os.environ)
        self.env["DEVELOPER_DIR"] = config["xcode"].get("developer_dir", "/Applications/Xcode.app/Contents/Developer")
        self.result = {"status": "pending", "installed": False, "launched": False,
                       "script": str(output / COMMAND), "log_dir": str(self.run_dir),
                       "test": dict(config["test"]), "adjust_environment": config["adjust"]["environment"],
                       "started_at": now().isoformat()}

    @staticmethod
    def load_prepare():
        spec = importlib.util.spec_from_file_location("ios05_prepare", Path(__file__).with_name("prepare_test_project.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.prepare

    def command(self, args, name, timeout):
        log = self.run_dir / (name + ".log")
        try:
            code = self.backend.run([str(arg) for arg in args], log=log, env=self.env, timeout=timeout)
        except (OSError, TimeoutError) as exc:
            fail(name + "_unavailable", str(exc), pending=True)
        return code, log

    def device_json(self, args, name, timeout=30):
        path = self.run_dir / (name + ".json")
        code, log = self.command(["/usr/bin/xcrun", "devicectl", "--timeout", str(timeout),
                                  "--json-output", str(path)] + args, name, timeout + 5)
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            fail(name + "_failed", "设备命令没有有效 JSON 结果；查看 " + str(log), pending=True)
        if code or data.get("info", {}).get("outcome") != "success":
            fail(name + "_failed", "设备命令失败；查看 " + str(log), pending=True)
        return data.get("result", {})

    @staticmethod
    def device_eligibility(device):
        """Only discovery facts: lock state and Xcode readiness need later probes."""
        hardware = device.get("hardwareProperties", {})
        connection, properties = device.get("connectionProperties", {}), device.get("deviceProperties", {})
        if hardware.get("deviceType") not in ("iPhone", "iPad") or hardware.get("reality", "physical") != "physical":
            return "unsupported_device", "该记录不是实体 iPhone/iPad。"
        if not all(isinstance(value, str) and value for value in (device.get("identifier"), hardware.get("udid"))):
            return "device_identifiers_missing", "设备缺少 CoreDevice identifier 或硬件 UDID，不能猜测安装目标。"
        if connection.get("pairingState") != "paired" or (connection.get("tunnelState") != "connected"
                and connection.get("transportType") != "wired"):
            return "device_not_ready", "目标设备尚未连接或配对，请在 Xcode 中完成配对。"
        if properties.get("developerModeStatus") not in (None, "enabled"):
            return "developer_mode_disabled", "目标设备开发者模式未开启。"
        return None, None

    def pick_device(self):
        result = self.device_json(["list", "devices"], "devices")
        devices = result.get("devices")
        if not isinstance(devices, list) or any(not isinstance(device, dict) for device in devices):
            fail("device_query_failed", "CoreDevice 返回的数据不含有效设备列表。", True)
        diagnostics = []
        for device in devices:
            reason, message = self.device_eligibility(device)
            diagnostics.append({"identifier": device.get("identifier"),
                                "udid": device.get("hardwareProperties", {}).get("udid"),
                                "name": device.get("deviceProperties", {}).get("name", "iOS device"),
                                "eligible_for_lock_check": reason is None, "reason": reason,
                                "message": message})
        self.result["device_candidates"] = diagnostics
        requested = self.config["test"].get("device_id")
        if requested:
            # Explicit selection is authoritative. An unusable requested device
            # must never silently fall through to a different available phone.
            matches = [device for device in devices if requested in
                       (device.get("identifier"), device.get("hardwareProperties", {}).get("udid"))]
            if not matches:
                fail("no_device", "未找到指定 identifier 或硬件 UDID；已保留一键安装脚本。", True)
            if len(matches) != 1:
                fail("multiple_devices", "指定标识匹配多个记录，不能唯一确定目标设备。", True)
            device = matches[0]
            reason, message = self.device_eligibility(device)
            if reason:
                fail(reason, message, True)
        else:
            # Filter definite discovery failures before checking uniqueness.
            # A paired, developer-enabled phone remains eligible even when its
            # wired tunnel/DDI needs Xcode preparation; locks are queried below.
            available = [device for device, item in zip(devices, diagnostics) if item["eligible_for_lock_check"]]
            if not available:
                if len(diagnostics) == 1:
                    fail(diagnostics[0]["reason"], diagnostics[0]["message"], True)
                fail("no_device" if not devices else "no_usable_device",
                     "未找到可用的实体 iPhone/iPad；排除原因已记录在 device_candidates，已保留安装脚本。", True)
            if len(available) != 1:
                fail("multiple_devices", "存在多个可用候选设备；在 resources/config.json 的 test.device_id 填入目标设备的 identifier 或硬件 UDID 后重试。", True)
            device = available[0]
        connection, properties = device.get("connectionProperties", {}), device.get("deviceProperties", {})
        core_id, udid = device["identifier"], device["hardwareProperties"]["udid"]
        self.result["device"] = {"name": properties.get("name", "iOS device"), "identifier": core_id, "udid": udid,
                                 "pairing_state": connection.get("pairingState"),
                                 "tunnel_state": connection.get("tunnelState"),
                                 "transport": connection.get("transportType"),
                                 "developer_mode": properties.get("developerModeStatus", "unknown"),
                                 "ddi_services_available": properties.get("ddiServicesAvailable", "unknown")}
        # A wired device can be usable before CoreDevice reports a connected tunnel.
        # Unknown/initial DDI readiness is resolved by Xcode using this exact UDID;
        # explicit disabled developer mode is never treated as usable.
        if properties.get("ddiServicesAvailable") is False:
            print("设备 DDI 尚未就绪，将由 Xcode 对指定硬件 UDID 验证/准备；失败时保留脚本。", flush=True)
        self.check_unlocked(core_id, "lock_before_build")
        return core_id, udid

    def check_unlocked(self, core_id, name):
        state = self.device_json(["device", "info", "lockState", "--device", core_id], name, 15)
        # CoreDevice lockState reports passcodeRequired; retain compatibility with
        # explicit isLocked fields. Unknown JSON fails closed, without guessing.
        locked = state.get("passcodeRequired", state.get("isLocked"))
        if not isinstance(locked, bool):
            fail("lock_state_unknown", "无法确认设备是否已解锁；解锁后重新运行脚本。", True)
        if locked:
            fail("device_locked", "设备已锁定；请解锁并重新运行一键安装脚本。", True)

    def settings(self, project, configuration, name, extra=()):
        args = ["/usr/bin/xcodebuild", "-project", project, "-scheme", self.config["project"]["scheme"],
                "-configuration", configuration, "-sdk", "iphoneos"] + list(extra) + ["-showBuildSettings", "-json"]
        code, log = self.command(args, name, 120)
        if code:
            fail("build_settings_failed", "无法读取构建设置；查看 " + str(log))
        try:
            rows = json.loads(log.read_text())
        except ValueError:
            fail("build_settings_failed", "xcodebuild 未返回有效 JSON；查看 " + str(log))
        if not isinstance(rows, list):
            fail("build_settings_failed", "xcodebuild 构建设置不是数组。")
        matches = [row.get("buildSettings", {}) for row in rows
                   if row.get("target") == self.config["project"]["target"]]
        if len(matches) != 1:
            fail("target_ambiguous", "构建设置中不能唯一匹配主 App target。")
        return matches[0], rows

    @staticmethod
    def expand(value, settings):
        for unused in range(10):
            if not isinstance(value, str):
                return value
            expanded = VARIABLE.sub(lambda match: str(settings.get(match.group(1) or match.group(2), match.group(0))), value)
            if expanded == value:
                break
            value = expanded
        if isinstance(value, str) and VARIABLE.search(value):
            fail("unresolved_setting", "构建变量无法解析：" + value)
        return value

    def verify_source(self, settings):
        info_setting = settings.get("INFOPLIST_FILE")
        if not info_setting:
            fail("unsupported_info", "当前测试 helper 要求显式 INFOPLIST_FILE；先适配独立测试准备逻辑。")
        info_path = Path(info_setting)
        if not info_path.is_absolute() or not info_path.is_file():
            info_path = Path(self.expand(info_setting, settings))
        if not info_path.is_absolute():
            info_path = Path(settings.get("SRCROOT", Path(self.config["project"]["path"]).parent)) / info_path
        info = plistlib.loads(info_path.read_bytes())
        for key, expected in (("CFBundleIdentifier", self.config["app"]["bundle_id"]),
                              ("CFBundleShortVersionString", self.config["app"]["version"]),
                              ("CFBundleVersion", self.config["app"]["build"])):
            if str(self.expand(info.get(key, ""), settings)) != expected:
                fail("source_config_mismatch", "正式工程的 {} 与参数不一致，请先核对正确工程。".format(key))
        self.expected_att = info.get("NSUserTrackingUsageDescription")
        self.source_root = Path(settings.get("SRCROOT", Path(self.config["project"]["path"]).parent))
        self.verify_host_options(info, "正式工程")

    def verify_host_options(self, info, label):
        expected_att = self.config["app"].get("tracking_usage_description", getattr(self, "expected_att", None))
        if expected_att is not None and info.get("NSUserTrackingUsageDescription") != expected_att:
            fail("payload_mismatch", label + " ATT 文案与本次配置／源文件不一致。")
        for field, key in (("startup_loading", "PAKitStartupLoadingEnabled"),
                           ("safe_area", "PAKitSafeAreaEnabled"),
                           ("initial_page_timeout_seconds", "PAKitInitialPageTimeoutSeconds")):
            if field in self.config.get("ui", {}):
                expected = self.config["ui"][field]
                actual = info.get(key)
                if type(expected) is bool:
                    matches = actual is expected
                else:
                    matches = type(actual) in (int, float) and actual == expected
                if not matches:
                    fail("payload_mismatch", label + " " + key + " 与本次UI配置不一致。")

    def verify_privacy(self, framework):
        root = getattr(self, "source_root", Path(self.config["project"]["path"]).parent)
        source = Path(root) / "UnityFramework/PrivacyInfo.xcprivacy"
        actual = framework / "PrivacyInfo.xcprivacy"
        if not source.is_file():
            fail("privacy_source_missing", "无法核验源 UnityFramework PrivacyInfo.xcprivacy；请确认实际资源路径后再安装。")
        if not actual.is_file():
            fail("payload_mismatch", "最终 UnityFramework 缺少 PrivacyInfo.xcprivacy，停止安装。")
        expected, value = plistlib.loads(source.read_bytes()), plistlib.loads(actual.read_bytes())
        if not isinstance(expected, dict) or not isinstance(value, dict) or value != expected:
            fail("payload_mismatch", "最终 UnityFramework 隐私声明与本次源清单不一致；需人工核对实际打包资源。")
        self.result["privacy_verified"] = True

    @staticmethod
    def source_metadata(project):
        return {str(path): sha(path.read_bytes()) for path in project.rglob("*")
                if path.is_file() and "xcuserdata" not in path.relative_to(project).parts}

    def verify_metadata_unchanged(self, project, baseline):
        if self.source_metadata(project) != baseline:
            fail("source_changed", "正式 .xcodeproj 元数据在本次流程中发生变化，停止安装。")

    def verify_sources_unchanged(self, preparation):
        marker = Path(preparation["project"]).parent / ".05ios-test-project.json"
        if not marker.exists():
            marker = Path(preparation["project"]).parent / ".24ios-test-project.json"
        hashes = json.loads(marker.read_text())["source_sha256"]
        if any(not Path(path).is_file() or sha(Path(path).read_bytes()) != expected for path, expected in hashes.items()):
            fail("source_changed", "正式工程在本次测试过程中发生变化，停止安装并保留日志。")
        self.result["source_unchanged"] = True

    def verify_app(self, path, framework_id):
        info = plistlib.loads((path / "Info.plist").read_bytes())
        test, sdk = self.config["test"], self.config["sdk"]
        for key, expected in (("CFBundleIdentifier", test["bundle_id"]),
                              ("CFBundleShortVersionString", test["version"]), ("CFBundleVersion", test["build"]),
                              ("PAKitAppStoreID", sdk["app_store_id"]),
                              ("PAKitExpectedConfigEndpoint", sdk["expected_config_endpoint"])):
            if str(info.get(key, "")) != expected:
                fail("payload_mismatch", "实际 .app 的 {} 不符合要求，停止安装。".format(key))
        if info.get("PAKitIntegrationEnabled") is not True:
            fail("payload_mismatch", "实际 .app 未启用 PAKitIntegrationEnabled。")
        if not isinstance(info.get("NSUserTrackingUsageDescription"), str) or not info["NSUserTrackingUsageDescription"].strip():
            fail("payload_mismatch", "实际 .app 缺少 ATT 授权文案。")
        self.verify_host_options(info, "实际 .app")
        executable = info.get("CFBundleExecutable", "")
        if not isinstance(executable, str) or Path(executable).name != executable or not (path / executable).is_file():
            fail("payload_mismatch", "实际 .app 缺少可执行文件。")
        framework = path / "Frameworks/UnityFramework.framework/Info.plist"
        if framework_id:
            if not framework.is_file() or plistlib.loads(framework.read_bytes()).get("CFBundleIdentifier") != framework_id:
                fail("payload_mismatch", "UnityFramework 包名被覆盖或 framework 缺失，停止安装。")
            self.verify_privacy(framework.parent)
        elif framework.exists():
            fail("payload_mismatch", "构建产物包含未在源构建设置中识别的 UnityFramework，须人工核对。")
        self.result["app"] = {"path": str(path), "bundle_id": test["bundle_id"], "version": test["version"],
                              "build": test["build"], "unity_framework_id": framework_id}

    def execute(self):
        core_id, udid = self.pick_device()
        project = Path(self.config["project"]["path"])
        metadata_baseline = self.source_metadata(project)
        scheme = project / "xcshareddata/xcschemes" / (self.config["project"]["scheme"] + ".xcscheme")
        archive = ET.fromstring(scheme.read_bytes()).find("ArchiveAction")
        formal_configuration = archive.get("buildConfiguration", "Release") if archive is not None else "Release"
        source_settings, source_rows = self.settings(str(project), formal_configuration, "source_settings")
        self.verify_metadata_unchanged(project, metadata_baseline)
        self.verify_source(source_settings)
        team = self.config["test"].get("team_id") or source_settings.get("DEVELOPMENT_TEAM")
        if not isinstance(team, str) or not re.fullmatch(r"[A-Za-z0-9]{10}", team):
            fail("team_missing", "无法确定开发团队，在 test.team_id 填入 Xcode 的 Team ID。", True)
        unity = [row.get("buildSettings", {}) for row in source_rows if row.get("target") == self.config["project"].get("framework_target", "UnityFramework")
                 or row.get("buildSettings", {}).get("FULL_PRODUCT_NAME") == "UnityFramework.framework"]
        if len(unity) > 1:
            fail("framework_ambiguous", "源工程包含多个 UnityFramework 构建设置。")
        framework_id = unity[0].get("PRODUCT_BUNDLE_IDENTIFIER") if unity else None
        if unity and not framework_id:
            fail("framework_id_missing", "无法确定原始 UnityFramework 包名。")
        test = self.config["test"]
        try:
            prepared = self.prepare(SimpleNamespace(project=str(project), output_dir=str(self.run_dir / "TestProject"),
                                   bundle_id=test["bundle_id"], version=test["version"], build=test["build"],
                                   target=self.config["project"]["target"], configuration="Debug", scheme=self.config["project"]["scheme"]))
        except Exception as exc:
            fail("prepare_failed", "独立测试工程准备失败：" + str(exc))
        write_json(self.run_dir / "prepared.json", prepared)
        derived = self.run_dir / "DerivedData"
        extra = ["-destination", "id=" + udid, "-derivedDataPath", str(derived)]
        test_settings, unused = self.settings(prepared["project"], "Debug", "test_settings", extra)
        app = Path(self.expand(test_settings.get("TARGET_BUILD_DIR", ""), test_settings)) / self.expand(test_settings.get("FULL_PRODUCT_NAME", ""), test_settings)
        if app.suffix != ".app" or not app.is_absolute():
            fail("app_path_unknown", "无法从独立测试 target 设置确定实际 .app 路径。")
        args = ["/usr/bin/xcodebuild", "-project", prepared["project"], "-scheme", prepared["scheme"],
                "-configuration", "Debug"] + extra + ["DEVELOPMENT_TEAM=" + team,
                "CODE_SIGN_STYLE=Automatic", "CODE_SIGN_IDENTITY=Apple Development", "COMPILER_INDEX_STORE_ENABLE=NO",
                "CLANG_MODULE_CACHE_PATH=" + str(self.run_dir / "ModuleCache"),
                "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration", "build"]
        print("构建独立测试包 {} / {} ({})；日志：{}".format(test["bundle_id"], test["version"], test["build"], self.run_dir / "build.log"), flush=True)
        code, log = self.command(args, "build", 1800)
        if code:
            text = log.read_text(errors="replace")
            if any(term in text for term in ("PLA Update", "Program License Agreement", "license agreement")):
                fail("license_agreement_required", "Apple Developer 计划协议尚未接受；账号持有人接受后重跑脚本。这不是手机权限问题。日志：" + str(log), True)
            if any(term in text for term in ("Unable to find a destination", "Ineligible destinations", "Failed to prepare device", "Developer Mode disabled")):
                fail("destination_unavailable", "Xcode 无法将指定硬件 UDID 用于构建；检查配对、开发者模式与 DDI 后重跑脚本。", True)
            if any(term in text for term in ("No profiles for", "provisioning profile", "requires a development team")):
                fail("provisioning_failed", "开发签名或描述文件准备失败；查看 Xcode 账号/团队与 build.log。", True)
            fail("build_failed", "构建失败，未安装；查看 " + str(log))
        self.result["device"]["xcode_destination_validated"] = True
        self.verify_metadata_unchanged(project, metadata_baseline)
        self.verify_sources_unchanged(prepared)
        self.verify_app(app, framework_id)
        code, log = self.command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], "signature", 30)
        if code:
            fail("signature_failed", "构建 App 签名验证失败，停止安装；查看 " + str(log))
        self.check_unlocked(core_id, "lock_before_install")
        installed = self.device_json(["device", "install", "app", "--device", core_id, str(app)], "install", 180)
        if installed.get("deviceIdentifier") != core_id or not any(item.get("bundleID") == test["bundle_id"] for item in installed.get("installedApplications", [])):
            fail("install_unconfirmed", "安装命令结果未确认目标设备与测试包名；停止启动。", True)
        self.result["installed"] = True
        launched = self.device_json(["device", "process", "launch", "--device", core_id, "--terminate-existing", test["bundle_id"]], "launch", 60)
        if launched.get("deviceIdentifier") != core_id or not isinstance(launched.get("process", {}).get("processIdentifier"), int):
            fail("launch_unconfirmed", "App 已安装，但未确认成功启动；查看 launch 日志。", True)
        self.result.update(status="installed_and_launched", launched=True, reason="complete",
                           message="测试 App 已安装并启动；继续在手机验证 SDK、ATT、Loading 与失败回游戏。")

    def run(self):
        self.output.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(str(self.output / ".delivery.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
                fail("invalid_lock", "安装锁不是普通文件。")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.result.update(status="pending", reason="already_running", message="另一个安装流程正在运行，已保留脚本。")
            else:
                try:
                    self.execute()
                except DeliveryError as exc:
                    self.result.update(status="pending" if exc.pending else "failed", reason=exc.reason, message=str(exc))
                except (OSError, ValueError, TypeError, KeyError, ET.ParseError) as exc:
                    self.result.update(status="failed", reason="invalid_project_or_payload", message=str(exc))
        self.result["finished_at"] = now().isoformat()
        write_json(self.run_dir / "result.json", self.result)
        write_json(self.output / "status.json", self.result)
        print(json.dumps(self.result, ensure_ascii=False, indent=2), flush=True)
        return self.result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--script-only", action="store_true", help="仅生成安装脚本；不探测设备、不构建、不安装")
    parser.add_argument("--execute", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        config, output = load_config(args.config.resolve()), args.output_dir.resolve()
        if not args.execute:
            emit_bundle(config, output)
        if args.script_only:
            result = {"status": "script_ready", "installed": False, "launched": False,
                      "script": str(output / COMMAND), "message": "已生成完整的一键安装文件夹；本次未探测设备或安装。"}
            write_json(output / "status.json", result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            result = Runner(config, output).run()
        return 0 if result["status"] in ("script_ready", "installed_and_launched") else 2 if result["status"] == "pending" else 1
    except (DeliveryError, OSError, ValueError, TypeError) as exc:
        print("交付失败：" + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
