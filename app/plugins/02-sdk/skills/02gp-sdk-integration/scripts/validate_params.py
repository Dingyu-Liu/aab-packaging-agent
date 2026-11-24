#!/usr/bin/env python3
"""Validate 02GP SDK integration parameters before touching a Unity project."""

import argparse
import json
import sys
from pathlib import Path


def fail(message):
    raise ValueError(message)


def require(mapping, path):
    value = mapping
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            fail("missing required parameter: " + path)
        value = value[part]
    return value


def masked(value):
    if not isinstance(value, str) or not value:
        return value
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("params", type=Path)
    parser.add_argument("--allow-placeholders", action="store_true",
                        help="Warn instead of failing for template paths and secrets")
    args = parser.parse_args()

    try:
        data = json.loads(args.params.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            fail("top-level JSON must be an object")

        project = Path(require(data, "project_path")).expanduser()
        unity = require(data, "unity_executable")
        formal = str(require(data, "android.formal_application_id")).strip()
        test = str(require(data, "android.test_application_id")).strip()
        version = str(require(data, "android.version_name")).strip()
        code = require(data, "android.version_code")
        abi = str(require(data, "android.abi")).strip()
        orientation = str(require(data, "android.orientation")).strip()
        hardware = require(data, "android.hardware_accelerated")

        for key in ("pa.maven_group", "pa.artifact", "pa.version", "pa.repository_url",
                    "apps_flyer.dev_key", "build.output_dir"):
            require(data, key)

        if not formal or not test:
            fail("formal and test applicationId must not be empty")
        if formal == test:
            fail("formal and test applicationId must be different")
        if not isinstance(code, int) or code <= 0:
            fail("android.version_code must be a positive integer")
        if not isinstance(hardware, bool):
            fail("android.hardware_accelerated must be boolean")
        if orientation not in ("portrait", "landscape", "autorotation"):
            fail("android.orientation must be portrait, landscape or autorotation")
        if abi not in ("arm64-v8a", "armeabi-v7a", "arm64-v8a,armeabi-v7a"):
            fail("unsupported android.abi: " + abi)

        warnings = []
        if not test.endswith(".test"):
            warnings.append("test applicationId does not end with .test")
        if not project.exists():
            message = "project_path does not exist: " + str(project)
            if args.allow_placeholders:
                warnings.append(message)
            else:
                fail(message)
        unity_path = Path(unity).expanduser()
        if not unity_path.exists():
            message = "unity_executable does not exist: " + str(unity_path)
            if args.allow_placeholders:
                warnings.append(message)
            else:
                fail(message)

        dev_key = str(require(data, "apps_flyer.dev_key"))
        if dev_key.startswith("<") or dev_key.upper().startswith("REPLACE"):
            warnings.append("AppsFlyer dev_key is still a placeholder")

        print("parameters valid")
        print("project: {}".format(project))
        print("formal: {}  test: {}".format(formal, test))
        print("version: {} ({})".format(version, code))
        print("PA: {}:{}:{}".format(
            require(data, "pa.maven_group"), require(data, "pa.artifact"),
            require(data, "pa.version")))
        print("AF key: {}".format(masked(dev_key)))
        print("orientation: {}  hardwareAccelerated: {}".format(orientation, hardware))
        print("output: {}".format(require(data, "build.output_dir")))
        for warning in warnings:
            print("WARNING: " + warning)
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print("INVALID: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
