#!/usr/bin/env python3
"""Measure the current local WPS identity using the audited gate-3 worker."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--wps-application", required=True, type=Path)
    parser.add_argument("--wpscomposer-root", required=True, type=Path)
    parser.add_argument("--wps-bridge-relative-path", required=True)
    parser.add_argument("--wps-executable-relative-path", default="Contents/MacOS/wpsoffice")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("superwagie_wps_worker", args.worker)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target_kind = "windows-executable" if sys.platform == "win32" else "macos-app-bundle"
    identity = module.measured_wps_identity(argparse.Namespace(
        expected_wps_identity_json=json.dumps({
            "target_kind": target_kind,
            "executable_sha256": "0" * 64,
            "bundle_manifest_sha256": "0" * 64,
            "bridge_sha256": "0" * 64,
        }),
        wps_application=args.wps_application,
        wpscomposer_root=args.wpscomposer_root,
        wps_bridge_relative_path=args.wps_bridge_relative_path,
        wps_executable_relative_path=args.wps_executable_relative_path,
    ))
    print(json.dumps(identity, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
