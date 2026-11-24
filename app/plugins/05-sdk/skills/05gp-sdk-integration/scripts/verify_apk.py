#!/usr/bin/env python3
"""Read-only APK checks using Python 3.9+ and Android Build Tools; no device access."""

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_tool(command):
    result = subprocess.run(
        [str(part) for part in command], capture_output=True, text=True,
        errors="replace", timeout=60,
    )
    require(
        result.returncode == 0,
        "{} failed ({}): {}".format(
            Path(command[0]).name, result.returncode,
            (result.stderr or result.stdout)[-3500:],
        ),
    )
    return result.stdout


def cert_digest(value):
    normalized = value.replace(":", "").replace(" ", "").lower()
    require(bool(re.fullmatch(r"[0-9a-f]{64}", normalized)), "Invalid SHA-256 certificate digest")
    return normalized


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--build-tools", required=True, type=Path, help="Android Build Tools directory")
    parser.add_argument("--expected-package", required=True)
    parser.add_argument("--expected-version", required=True, help="APK versionName, not Maven version")
    parser.add_argument("--expected-version-code")
    parser.add_argument("--expected-min-sdk", type=int, help="Require this exact effective minSdk")
    parser.add_argument("--expected-target-sdk", type=int, help="Require this exact effective targetSdk")
    parser.add_argument("--expected-launcher", help="Require this actual launchable Activity class")
    parser.add_argument("--forbidden-cert-sha256", action="append", default=[], help="Reject any supplied production signing certificate")
    parser.add_argument("--expected-abi", action="append", default=[], help="Repeat to require the exact ABI set")
    parser.add_argument("--expected-cert-sha256", action="append", default=[], help="Repeat for all expected signers")
    parser.add_argument("--sdk-aar", type=Path, help="Resolved target AAR; Maven version is checked separately")
    parser.add_argument("--sdk-library", default="libpakit.so")
    parser.add_argument("--merged-native-root", type=Path, help="Build output lib directory containing ABI directories")
    parser.add_argument("--stripped-native-root", type=Path, help="Build output lib directory after strip, before APK packaging")
    parser.add_argument("--expected-domain", help="Require this string in the SDK native library; not a network test")
    parser.add_argument("--no-toast-class", action="append", type=Path, default=[], help="Freshly compiled host .class file; repeat as needed")
    parser.add_argument("--lint-report", type=Path, help="XML report from the relevant completed lint task")
    parser.add_argument("--report", type=Path, help="Write validation JSON; exit code is nonzero on failed checks")
    return parser.parse_args()


def validate(args, report):
    require(args.apk.is_file(), "APK does not exist: " + str(args.apk))
    require(
        bool(args.merged_native_root) == bool(args.stripped_native_root),
        "Use --merged-native-root and --stripped-native-root together",
    )
    require(not args.merged_native_root or args.sdk_aar, "Native output comparison requires --sdk-aar")
    require(args.sdk_library == Path(args.sdk_library).name, "--sdk-library must be a file name")
    executable_suffix = ".exe" if os.name == "nt" else ""
    signing_suffix = ".bat" if os.name == "nt" else ""
    aapt = args.build_tools / ("aapt" + executable_suffix)
    apksigner = args.build_tools / ("apksigner" + signing_suffix)
    report["apk_sha256"] = sha256(args.apk)
    report["size_bytes"] = args.apk.stat().st_size

    badging = run_tool([aapt, "dump", "badging", args.apk])
    package_line = next((line for line in badging.splitlines() if line.startswith("package: ")), "")
    metadata = dict(re.findall(r"(\w+)='([^']*)'", package_line))
    report["package"] = metadata.get("name")
    report["version_name"] = metadata.get("versionName")
    report["version_code"] = metadata.get("versionCode")
    require(metadata.get("name") == args.expected_package, "APK package mismatch: " + str(metadata.get("name")))
    require(metadata.get("versionName") == args.expected_version, "APK versionName mismatch: " + str(metadata.get("versionName")))
    if args.expected_version_code is not None:
        require(metadata.get("versionCode") == args.expected_version_code, "APK versionCode mismatch")
    for name, pattern in [
        ("min_sdk", r"^sdkVersion:'([^']+)'"),
        ("target_sdk", r"^targetSdkVersion:'([^']+)'"),
        ("launcher", r"^launchable-activity: name='([^']+)'"),
    ]:
        match = re.search(pattern, badging, re.MULTILINE)
        report[name] = match.group(1) if match else None

    if args.expected_min_sdk is not None:
        require(report["min_sdk"] == str(args.expected_min_sdk), "APK minSdk mismatch")
    if args.expected_target_sdk is not None:
        require(report["target_sdk"] == str(args.expected_target_sdk), "APK targetSdk mismatch")
    if args.expected_launcher is not None:
        require(report["launcher"] == args.expected_launcher, "APK launchable Activity mismatch")

    signing = run_tool([apksigner, "verify", "--print-certs", args.apk])
    actual_certs = {
        cert_digest(item) for item in re.findall(
            r"^Signer #\d+ certificate SHA-256 digest:\s*(.+)$", signing, re.MULTILINE
        )
    }
    require(bool(actual_certs), "No signing certificate reported")
    if args.expected_cert_sha256:
        expected_certs = {cert_digest(item) for item in args.expected_cert_sha256}
        require(actual_certs == expected_certs, "Signing certificate mismatch")
    forbidden_certs = {cert_digest(item) for item in args.forbidden_cert_sha256}
    require(not actual_certs.intersection(forbidden_certs), "APK is signed with a forbidden production certificate")
    report["signature_verified"] = True
    report["signer_sha256"] = sorted(actual_certs)

    with ZipFile(args.apk) as apk:
        require(apk.testzip() is None, "APK ZIP integrity check failed")
        native_entries = [
            name for name in apk.namelist()
            if re.fullmatch(r"lib/[^/]+/[^/]+\.so", name)
        ]
        abis = sorted({name.split("/")[1] for name in native_entries})
        report["abis"] = abis
        if args.expected_abi:
            require(set(abis) == set(args.expected_abi), "APK ABI set mismatch: " + str(abis))
        if args.sdk_aar or args.expected_domain:
            require(bool(abis), "No native libraries in APK")
            for abi in abis:
                name = "lib/{}/{}".format(abi, args.sdk_library)
                require(name in native_entries, "Missing SDK library: " + name)
                if args.expected_domain:
                    require(args.expected_domain.encode() in apk.read(name), "SDK domain string not found in " + name)
            report["sdk_domain_string"] = args.expected_domain
        if args.sdk_aar:
            with ZipFile(args.sdk_aar) as aar:
                for abi in abis:
                    source_name = "jni/{}/{}".format(abi, args.sdk_library)
                    require(source_name in aar.namelist(), "Target AAR lacks " + source_name)
                    source = aar.read(source_name)
                    packaged = apk.read("lib/{}/{}".format(abi, args.sdk_library))
                    if args.merged_native_root:
                        merged = args.merged_native_root / abi / args.sdk_library
                        stripped = args.stripped_native_root / abi / args.sdk_library
                        require(source == merged.read_bytes(), "AAR to merged native mismatch for " + abi)
                        require(packaged == stripped.read_bytes(), "Stripped native to APK mismatch for " + abi)
                    else:
                        require(source == packaged, "AAR/APK native bytes differ for {}; if stripped, provide both native output roots".format(abi))
            report["sdk_aar_sha256"] = sha256(args.sdk_aar)
            report["native_comparison"] = (
                "AAR matches merged output; APK matches stripped output from the completed build"
                if args.merged_native_root else "AAR native library bytes match APK directly"
            )

    report["host_classes_without_toast"] = []
    for path in args.no_toast_class:
        data = path.read_bytes()
        require(data[:4] == b"\xca\xfe\xba\xbe", "Not a compiled Java class: " + str(path))
        require(b"android/widget/Toast" not in data, "Toast reference remains in host class: " + str(path))
        report["host_classes_without_toast"].append(str(path.resolve()))
    if args.lint_report:
        issues = ET.parse(args.lint_report).getroot().findall("issue")
        report["lint"] = dict(Counter(issue.get("severity", "Unknown") for issue in issues))
        blocking = [issue.get("id", "Unknown") for issue in issues if issue.get("severity") in ("Error", "Fatal")]
        require(not blocking, "Lint errors: " + ", ".join(blocking))
    report["device_test"] = "not performed by this verifier"


def main():
    args = arguments()
    report = {"status": "failed", "apk": str(args.apk.resolve())}
    # A report must never overwrite the APK or other input artifacts.
    inputs = [args.apk, args.sdk_aar, args.lint_report] + args.no_toast_class
    if args.report:
        if args.report.suffix.lower() != ".json" or any(
            args.report.resolve() == path.resolve() for path in inputs if path
        ):
            print("Report must be a separate .json file", file=sys.stderr)
            return 2
    try:
        validate(args, report)
        report["status"] = "passed"
    except (ValueError, OSError, KeyError, subprocess.SubprocessError, ET.ParseError) as error:
        report["error"] = str(error)
    except Exception as error:
        # Malformed ZIPs and unexpected parser errors also fail closed.
        report["error"] = "{}: {}".format(type(error).__name__, error)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        try:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(text, encoding="utf-8")
        except OSError as error:
            print("Cannot write report: " + str(error), file=sys.stderr)
            return 1
    print(text, end="")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
