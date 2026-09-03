#!/usr/bin/env python3
"""One-receipt adapter for an explicitly selected WPSComposer checkout."""

from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import inspect
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time
from typing import Any


BACKEND = "wpscomposer-explicit-source"
AUDITED_FAKE_PDF_SHA256 = "cb17b352b21ffc3e4286d5ffbdcbecb7a2f262ff41edca9eb1d514b5091f2b22"
COMPONENT_BY_SUFFIX = {
    ".doc": "writer",
    ".docx": "writer",
    ".ppt": "presentation",
    ".pptx": "presentation",
    ".xls": "spreadsheet",
    ".xlsx": "spreadsheet",
}
RUNTIME_MISSING_CODES = {
    "BACKEND_UNAVAILABLE",
    "MACOS_GATE_NOT_PASSED",
    "STAGING_UNAVAILABLE",
}
EXPLICIT_MODULE_NAME = "_superwagie_explicit_wpscomposer"
WPS_OWNERSHIP_STABILITY_SECONDS = 3.0
WPS_OWNERSHIP_CLEANUP_SECONDS = 10.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--wpscomposer-root", required=True, type=Path)
    parser.add_argument("--expected-source-sha256", required=True)
    parser.add_argument("--deadline-ms", required=True, type=int)
    parser.add_argument("--wps-application", required=True, type=Path)
    parser.add_argument("--expected-wps-identity-json", required=True)
    parser.add_argument("--wps-bridge-relative-path", required=True)
    parser.add_argument("--wps-executable-relative-path")
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def component_for(source: Path) -> str:
    try:
        return COMPONENT_BY_SUFFIX[source.suffix.lower()]
    except KeyError as exc:
        raise ValueError("unsupported Office source format") from exc


def receipt(status: str, code: str, component: str, **fields: object) -> dict[str, object]:
    return {
        "status": status,
        "code": code,
        "component": component,
        "backend": BACKEND,
        **fields,
    }


def emit(value: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def validate_absolute_file(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label} is unavailable")
    return resolved


def validate_args(args: argparse.Namespace) -> tuple[Path, Path, Path, str]:
    source = validate_absolute_file(args.source, "source")
    if not args.output.is_absolute():
        raise ValueError("output must be absolute")
    output = args.output.resolve()
    if output.suffix.lower() != ".pdf":
        raise ValueError("output must end in .pdf")
    if args.deadline_ms <= 0:
        raise ValueError("deadline must be positive")
    expected = args.expected_source_sha256
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise ValueError("expected source hash must be lowercase SHA-256")
    return source, output, args.wpscomposer_root, component_for(source)


def compact_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def confined_regular_file(root: Path, relative: str, label: str) -> Path:
    relative_path = Path(relative)
    if (
        not relative
        or relative_path.is_absolute()
        or ".." in relative_path.parts
    ):
        raise ValueError(f"{label} relative path is invalid")
    canonical_root = root.resolve(strict=True)
    requested = canonical_root / relative_path
    metadata = requested.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} must be a regular non-symlink file")
    canonical = requested.resolve(strict=True)
    if not canonical.is_relative_to(canonical_root):
        raise ValueError(f"{label} escaped its explicit root")
    return canonical


def canonical_macos_bundle_target_identity(
    root: Path,
    canonical: Path,
    active: set[Path],
    cache: dict[Path, dict[str, object]],
) -> dict[str, object]:
    if canonical in cache:
        return cache[canonical]
    if canonical in active:
        raise ValueError("WPS bundle symlink cycle detected")
    metadata = canonical.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISREG(metadata.st_mode):
        identity = {
            "type": "file", "mode": mode, "size": metadata.st_size,
            "sha256": sha256(canonical),
        }
        cache[canonical] = identity
        return identity
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("WPS bundle symlink target contains unsupported special file")
    active.add(canonical)
    try:
        children: list[dict[str, object]] = []
        for entry in sorted(canonical.iterdir(), key=lambda value: value.name.encode("utf-8")):
            if entry.name in {".DS_Store", "Caches", "Logs"} or entry.name.endswith(".log"):
                continue
            child_metadata = entry.lstat()
            child_mode = stat.S_IMODE(child_metadata.st_mode)
            if stat.S_ISLNK(child_metadata.st_mode):
                link_text = os.readlink(entry)
                target = entry.resolve(strict=True)
                if not target.is_relative_to(root):
                    raise ValueError("WPS bundle symlink escaped application root")
                encoded = link_text.encode("utf-8")
                target_identity = canonical_macos_bundle_target_identity(
                    root, target, active, cache,
                )
                children.append({
                    "name": entry.name, "type": "symlink", "mode": child_mode,
                    "size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(),
                    "target_type": target_identity["type"],
                    "target_mode": target_identity["mode"],
                    "target_size": target_identity["size"],
                    "target_sha256": target_identity["sha256"],
                })
            else:
                child_identity = canonical_macos_bundle_target_identity(
                    root, entry.resolve(strict=True), active, cache,
                )
                children.append({"name": entry.name, **child_identity})
        identity = {
            "type": "directory", "mode": mode, "size": 0,
            "sha256": compact_sha256(children),
        }
        cache[canonical] = identity
        return identity
    finally:
        active.remove(canonical)


def collect_macos_bundle_entry(
    root: Path,
    candidate: Path,
    output: list[dict[str, object]],
    active: set[Path],
    cache: dict[Path, dict[str, object]],
) -> None:
    if candidate.name in {".DS_Store", "Caches", "Logs"} or candidate.name.endswith(".log"):
        return
    metadata = candidate.lstat()
    identity = candidate.relative_to(root).as_posix()
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(candidate)
        canonical = candidate.resolve(strict=True)
        if not canonical.is_relative_to(root):
            raise ValueError("WPS bundle symlink escaped application root")
        encoded = target.encode("utf-8")
        target_identity = canonical_macos_bundle_target_identity(
            root, canonical, active, cache,
        )
        output.append({
            "identity": identity, "type": "symlink", "mode": mode,
            "size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(),
            "target_type": target_identity["type"],
            "target_mode": target_identity["mode"],
            "target_size": target_identity["size"],
            "target_sha256": target_identity["sha256"],
        })
        return
    if stat.S_ISDIR(metadata.st_mode):
        output.append({
            "identity": identity, "type": "directory", "mode": mode,
            "size": 0, "sha256": hashlib.sha256(b"").hexdigest(),
        })
        for entry in sorted(candidate.iterdir(), key=lambda value: value.name.encode("utf-8")):
            collect_macos_bundle_entry(root, entry, output, active, cache)
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("WPS bundle contains unsupported special file")
    output.append({
        "identity": identity, "type": "file", "mode": mode,
        "size": metadata.st_size, "sha256": sha256(candidate),
    })


def measured_wps_identity(args: argparse.Namespace) -> dict[str, str]:
    try:
        expected = json.loads(args.expected_wps_identity_json)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("expected WPS identity is invalid") from error
    required = {
        "target_kind", "executable_sha256", "bundle_manifest_sha256", "bridge_sha256"
    }
    if (
        not isinstance(expected, dict)
        or set(expected) != required
        or expected.get("target_kind") not in {"macos-app-bundle", "windows-executable"}
        or any(
            not isinstance(expected.get(key), str)
            or len(expected[key]) != 64
            or any(character not in "0123456789abcdef" for character in expected[key])
            for key in required - {"target_kind"}
        )
    ):
        raise ValueError("expected WPS identity is invalid")
    application = args.wps_application
    if not application.is_absolute():
        raise ValueError("WPS application must be absolute")
    bridge = confined_regular_file(
        args.wpscomposer_root,
        args.wps_bridge_relative_path,
        "WPS bridge",
    )
    if expected["target_kind"] == "windows-executable":
        metadata = application.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or application.suffix.lower() != ".exe":
            raise ValueError("Windows WPS application target is invalid")
        executable = application.resolve(strict=True)
        records = [{"identity": "application-executable", "sha256": sha256(executable)}]
    else:
        metadata = application.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or application.suffix != ".app":
            raise ValueError("macOS WPS application target is invalid")
        root = application.resolve(strict=True)
        executable = confined_regular_file(root, args.wps_executable_relative_path, "WPS executable")
        records: list[dict[str, object]] = []
        active: set[Path] = set()
        cache: dict[Path, dict[str, object]] = {}
        for relative in (
            "Contents/Info.plist", "Contents/MacOS", "Contents/Frameworks",
            "Contents/PlugIns", "Contents/Resources",
        ):
            candidate = root / relative
            try:
                collect_macos_bundle_entry(root, candidate, records, active, cache)
            except FileNotFoundError:
                if relative in {"Contents/Info.plist", "Contents/MacOS"}:
                    raise
        records.sort(key=lambda value: str(value["identity"]).encode("utf-8"))
    return {
        "target_kind": expected["target_kind"],
        "executable_sha256": sha256(executable),
        "bundle_manifest_sha256": compact_sha256(records),
        "bridge_sha256": sha256(bridge),
    }


def verify_wps_identity(args: argparse.Namespace) -> None:
    expected = json.loads(args.expected_wps_identity_json)
    if measured_wps_identity(args) != expected:
        raise ValueError("explicit WPS application identity changed")


def map_conversion_error(error: BaseException) -> tuple[str, str]:
    dependency_code = str(getattr(error, "code", ""))
    message = str(getattr(error, "message", error)).lower()
    if dependency_code in RUNTIME_MISSING_CODES:
        return "dependency_missing", "WPS_RUNTIME_MISSING"
    if dependency_code == "INTERACTIVE_INPUT_REQUIRED":
        return "failed", "WPS_INTERACTIVE_INPUT_REQUIRED"
    if "timeout" in message or "timed out" in message or "deadline" in message:
        return "failed", "WPS_RENDER_TIMEOUT"
    return "failed", "WPS_RENDER_FAILED"


def copy_fake_pdf(fake_pdf: Path, output: Path) -> Path:
    audited = validate_absolute_file(fake_pdf, "configured fake PDF")
    if (
        audited.name != "reviewer-torture-100p.pdf"
        or sha256(audited) != AUDITED_FAKE_PDF_SHA256
    ):
        raise ValueError("fake conversion accepts only the audited reviewer fixture")
    with audited.open("rb") as source_stream, output.open("xb") as output_stream:
        shutil.copyfileobj(source_stream, output_stream, length=1024 * 1024)
        output_stream.flush()
        os.fsync(output_stream.fileno())
    return output


def cleanup_explicit_namespace() -> None:
    for name in list(sys.modules):
        if name == EXPLICIT_MODULE_NAME or name.startswith(f"{EXPLICIT_MODULE_NAME}."):
            sys.modules.pop(name, None)


@contextmanager
def spawned_import_scope(package_root: Path, scratch_root: Path):
    canonical_package = package_root.resolve(strict=True)
    canonical_scratch = scratch_root.resolve(strict=True)
    if not canonical_package.is_dir() or not canonical_scratch.is_dir():
        raise ImportError("spawn import scope is unavailable")
    previous_path = list(sys.path)
    with tempfile.TemporaryDirectory(
        prefix=".superwagie-wps-spawn-",
        dir=canonical_scratch,
    ) as temporary:
        bootstrap_root = Path(temporary).resolve(strict=True)
        alias = bootstrap_root / EXPLICIT_MODULE_NAME
        alias.mkdir(mode=0o700)
        initializer = alias / "__init__.py"
        initializer.write_text(
            "__path__ = [%s]\n"
            % json.dumps(str(canonical_package), ensure_ascii=True),
            encoding="utf-8",
        )
        os.chmod(initializer, 0o600)
        sys.path.insert(0, str(bootstrap_root))
        try:
            yield
        finally:
            sys.path[:] = previous_path


@contextmanager
def isolated_macos_runtime_scope(runtime_module: Any, conversion_module: Any):
    original_probe_runtime = conversion_module.ProbeRuntime
    original_activation_command = runtime_module.activation_command
    original_convert_macos = conversion_module.convert_macos

    def isolated_activation_command(
        app_path: Path,
        fixture: Path,
        *,
        reuse_running: bool = True,
    ) -> list[str]:
        del reuse_running
        return original_activation_command(
            app_path,
            fixture,
            reuse_running=False,
        )

    class OwnedProbeRuntime(original_probe_runtime):
        def activate_component(
            self,
            component: str,
            *,
            deadline: float | None = None,
        ) -> Path:
            target = super().activate_component(component, deadline=deadline)
            before = getattr(self, "_wps_processes_before", None)
            if not isinstance(before, dict):
                raise RuntimeError("isolated WPS ownership baseline is unavailable")
            operation_deadline = deadline or getattr(self, "deadline", None)
            if not isinstance(operation_deadline, (int, float)):
                operation_deadline = time.monotonic() + 5.0
            ownership_deadline = min(operation_deadline, time.monotonic() + 5.0)
            while time.monotonic() < ownership_deadline:
                budget = max(0.001, ownership_deadline - time.monotonic())
                after = runtime_module.list_wps_processes(
                    self.wps_app,
                    timeout=min(0.5, budget),
                )
                owned = runtime_module.owned_wps_pids(set(before), set(after))
                if owned:
                    self._owned_wps_processes.update(
                        {pid: after[pid] for pid in owned}
                    )
                    return target
                time.sleep(min(0.05, budget))
            raise RuntimeError("isolated WPS ownership handshake failed")

        def close(self) -> None:
            ownership_error: BaseException | None = None
            try:
                before = getattr(self, "_wps_processes_before", None)
                if not isinstance(before, dict):
                    raise RuntimeError(
                        "isolated WPS ownership baseline is unavailable"
                    )
                after = runtime_module.list_wps_processes(
                    self.wps_app,
                    timeout=1.0,
                )
                owned = runtime_module.owned_wps_pids(set(before), set(after))
                self._owned_wps_processes.update(
                    {pid: after[pid] for pid in owned}
                )
            except BaseException as error:
                ownership_error = error
            cleanup_error: BaseException | None = None
            try:
                super().close()
            except BaseException as error:
                cleanup_error = error
            late_cleanup_error: BaseException | None = None
            try:
                self._cleanup_late_owned_wps()
            except BaseException as error:
                late_cleanup_error = error
            if cleanup_error is not None:
                raise RuntimeError("isolated WPS cleanup failed") from cleanup_error
            if ownership_error is not None or late_cleanup_error is not None:
                raise RuntimeError(
                    "isolated WPS ownership refresh failed"
                ) from (late_cleanup_error or ownership_error)

        def _cleanup_late_owned_wps(self) -> None:
            before = getattr(self, "_wps_processes_before", None)
            if not isinstance(before, dict):
                raise RuntimeError("isolated WPS ownership baseline is unavailable")
            cleanup_deadline = time.monotonic() + WPS_OWNERSHIP_CLEANUP_SECONDS
            stable_since: float | None = None
            while time.monotonic() < cleanup_deadline:
                budget = max(0.001, cleanup_deadline - time.monotonic())
                after = runtime_module.list_wps_processes(
                    self.wps_app,
                    timeout=min(0.5, budget),
                )
                owned = runtime_module.owned_wps_pids(set(before), set(after))
                if owned:
                    self._owned_wps_processes.update(
                        {pid: after[pid] for pid in owned}
                    )
                    original_probe_runtime._terminate_owned_wps(
                        self,
                        cleanup_deadline,
                    )
                    stable_since = None
                    continue
                now = time.monotonic()
                if stable_since is None:
                    stable_since = now
                elif now - stable_since >= WPS_OWNERSHIP_STABILITY_SECONDS:
                    return
                time.sleep(min(0.05, budget))
            raise RuntimeError("isolated WPS processes did not become stable")

    def isolated_convert_macos(request: Any, *args: Any, **kwargs: Any) -> Any:
        if "runtime_factory" in kwargs:
            raise RuntimeError("WPS runtime factory override is not permitted")
        return original_convert_macos(
            request,
            *args,
            runtime_factory=OwnedProbeRuntime,
            **kwargs,
        )

    runtime_module.activation_command = isolated_activation_command
    conversion_module.ProbeRuntime = OwnedProbeRuntime
    conversion_module.convert_macos = isolated_convert_macos
    try:
        yield
    finally:
        conversion_module.convert_macos = original_convert_macos
        conversion_module.ProbeRuntime = original_probe_runtime
        runtime_module.activation_command = original_activation_command


def canonical_confined_path(
    value: object,
    package_root: Path,
    label: str,
    *,
    directory: bool = False,
) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise ImportError(f"{label} origin is unverifiable")
    try:
        canonical = Path(value).resolve(strict=True)
    except OSError as error:
        raise ImportError(f"{label} origin is unavailable") from error
    expected_type = canonical.is_dir() if directory else canonical.is_file()
    if not expected_type or not canonical.is_relative_to(package_root):
        raise ImportError(f"{label} escaped the explicit package root")
    return canonical


def validate_private_spec(
    spec: importlib.machinery.ModuleSpec | None,
    package_root: Path,
    label: str,
) -> importlib.machinery.ModuleSpec:
    if spec is None or spec.loader is None:
        raise ImportError(f"{label} import origin is unverifiable")
    canonical_confined_path(spec.origin, package_root, label)
    locations = spec.submodule_search_locations
    if locations is not None:
        resolved_locations = [
            canonical_confined_path(
                location,
                package_root,
                f"{label} package search location",
                directory=True,
            )
            for location in locations
        ]
        if not resolved_locations:
            raise ImportError(f"{label} package search locations are empty")
    return spec


class ExplicitNamespaceFinder(importlib.abc.MetaPathFinder):
    def __init__(self, package_root: Path) -> None:
        self.package_root = package_root

    def find_spec(
        self,
        fullname: str,
        path: object = None,
        target: object = None,
    ) -> importlib.machinery.ModuleSpec | None:
        namespace = f"{EXPLICIT_MODULE_NAME}."
        if fullname != EXPLICIT_MODULE_NAME and not fullname.startswith(namespace):
            return None
        if fullname == EXPLICIT_MODULE_NAME or path is None:
            raise ImportError("explicit package namespace import fell through")
        try:
            search_locations = list(path)  # type: ignore[arg-type]
        except (TypeError, OSError) as error:
            raise ImportError("explicit package search path is unverifiable") from error
        if not search_locations:
            raise ImportError("explicit package search path is empty")
        for location in search_locations:
            canonical_confined_path(
                location,
                self.package_root,
                f"{fullname} parent search location",
                directory=True,
            )
        spec = importlib.machinery.PathFinder.find_spec(
            fullname,
            search_locations,
            target,
        )
        return validate_private_spec(spec, self.package_root, fullname)

    def __enter__(self) -> ExplicitNamespaceFinder:
        sys.meta_path.insert(0, self)
        return self

    def __exit__(self, *_error: object) -> None:
        while self in sys.meta_path:
            sys.meta_path.remove(self)


def validate_explicit_namespace(package_root: Path) -> dict[str, Path]:
    origins: dict[str, Path] = {}
    namespace = f"{EXPLICIT_MODULE_NAME}."
    for name, loaded in list(sys.modules.items()):
        if name != EXPLICIT_MODULE_NAME and not name.startswith(namespace):
            continue
        if loaded is None or getattr(loaded, "__name__", None) != name:
            raise ImportError("explicit package namespace registration is invalid")
        package_name = getattr(loaded, "__package__", None)
        if not isinstance(package_name, str) or (
            package_name != EXPLICIT_MODULE_NAME
            and not package_name.startswith(namespace)
        ):
            raise ImportError("explicit package namespace fell through")
        spec = getattr(loaded, "__spec__", None)
        origin = getattr(spec, "origin", None)
        module_file = getattr(loaded, "__file__", None)
        canonical_origin = canonical_confined_path(origin, package_root, name)
        canonical_file = canonical_confined_path(module_file, package_root, name)
        if canonical_origin != canonical_file:
            raise ImportError("explicit module file and spec origin disagree")
        origins[name] = canonical_origin

        spec_locations = getattr(spec, "submodule_search_locations", None)
        module_locations = getattr(loaded, "__path__", None)
        if (spec_locations is None) != (module_locations is None):
            raise ImportError("explicit package search locations are unverifiable")
        for locations in (spec_locations, module_locations):
            if locations is None:
                continue
            resolved_locations = [
                canonical_confined_path(
                    location,
                    package_root,
                    f"{name} package search location",
                    directory=True,
                )
                for location in locations
            ]
            if not resolved_locations:
                raise ImportError("explicit package search locations are empty")
    if EXPLICIT_MODULE_NAME not in origins:
        raise ImportError("explicit package namespace is unavailable")
    return origins


def validate_exposed_origin(
    value: object,
    label: str,
    package_root: Path,
    origins: dict[str, Path],
) -> None:
    module_name = getattr(value, "__module__", None)
    if not isinstance(module_name, str) or module_name not in origins:
        raise ImportError(f"{label} defining module is not explicit")
    try:
        source_file = inspect.getsourcefile(value) or inspect.getfile(value)
    except (TypeError, OSError) as error:
        raise ImportError(f"{label} defining origin is unverifiable") from error
    canonical_source = canonical_confined_path(source_file, package_root, label)
    if canonical_source != origins[module_name]:
        raise ImportError(f"{label} defining origin disagrees with its module")


def load_explicit_wpscomposer(composer_root: Path) -> tuple[Any, Any, Path]:
    try:
        canonical_root = composer_root.resolve(strict=True)
        package_init = (canonical_root / "skills/WPSComposer/__init__.py").resolve(
            strict=True
        )
    except OSError as error:
        raise ImportError("explicit WPSComposer package is unavailable") from error
    if not canonical_root.is_dir():
        raise ImportError("explicit WPSComposer root is unavailable")
    if not package_init.is_file() or not package_init.is_relative_to(canonical_root):
        raise ImportError("explicit WPSComposer package escaped its configured root")
    package_root = package_init.parent
    cleanup_explicit_namespace()
    spec = importlib.util.spec_from_file_location(
        EXPLICIT_MODULE_NAME,
        package_init,
        submodule_search_locations=[str(package_root)],
    )
    if spec is None or spec.loader is None:
        raise ImportError("explicit WPSComposer package is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[EXPLICIT_MODULE_NAME] = module
    try:
        spec.loader.exec_module(module)
        origins = validate_explicit_namespace(package_root)
        if origins[EXPLICIT_MODULE_NAME] != package_init:
            raise ImportError("loaded WPSComposer package origin was not explicit")
        conversion_error = module.ConversionError
        convert_to_pdf = module.convert_to_pdf
        if not isinstance(conversion_error, type) or not issubclass(
            conversion_error, BaseException
        ):
            raise ImportError("ConversionError is not an explicit exception type")
        if not inspect.isfunction(convert_to_pdf):
            raise ImportError("convert_to_pdf is not an explicit Python function")
        validate_exposed_origin(
            conversion_error,
            "ConversionError",
            package_root,
            origins,
        )
        validate_exposed_origin(
            convert_to_pdf,
            "convert_to_pdf",
            package_root,
            origins,
        )
        return conversion_error, convert_to_pdf, package_root
    except BaseException as error:
        cleanup_explicit_namespace()
        if isinstance(error, ImportError):
            raise
        raise ImportError("explicit WPSComposer package validation failed") from error


def call_explicit_converter(
    convert_to_pdf: Any,
    source: Path,
    output: Path,
    args: argparse.Namespace,
    package_root: Path,
) -> object:
    parameters = inspect.signature(convert_to_pdf).parameters
    common = {
        "output": str(output),
        "overwrite": False,
    }
    if "wps_application" in parameters:
        return convert_to_pdf(
            str(source),
            **common,
            wps_application=str(args.wps_application.resolve(strict=True)),
        )

    expected = json.loads(args.expected_wps_identity_json)
    if expected.get("target_kind") != "macos-app-bundle":
        raise ImportError("explicit WPS application selection is unsupported")
    runtime_name = f"{EXPLICIT_MODULE_NAME}.scripts.macos_probe.runtime"
    runtime = importlib.import_module(runtime_name)
    origins = validate_explicit_namespace(package_root)
    if runtime_name not in origins:
        raise ImportError("legacy WPS runtime binding is not explicit")
    configured = getattr(runtime, "WPS_APP", None)
    if not isinstance(configured, (str, os.PathLike)):
        raise ImportError("legacy WPS runtime target is unavailable")
    try:
        configured_path = Path(configured).resolve(strict=True)
        selected_path = args.wps_application.resolve(strict=True)
    except OSError as error:
        raise ImportError("legacy WPS runtime target is unavailable") from error
    if configured_path != selected_path:
        raise ImportError("legacy WPS runtime target disagrees with explicit selection")
    public_conversion_name = f"{EXPLICIT_MODULE_NAME}.scripts.conversion"
    if getattr(convert_to_pdf, "__module__", None) != public_conversion_name:
        return convert_to_pdf(str(source), **common)
    macos_conversion_name = (
        f"{EXPLICIT_MODULE_NAME}.scripts.macos_probe.conversion"
    )
    macos_conversion = importlib.import_module(macos_conversion_name)
    origins = validate_explicit_namespace(package_root)
    if macos_conversion_name not in origins or runtime_name not in origins:
        raise ImportError("legacy WPS isolation modules are not explicit")
    with isolated_macos_runtime_scope(runtime, macos_conversion):
        return convert_to_pdf(str(source), **common)


def render(args: argparse.Namespace) -> tuple[dict[str, object], int]:
    try:
        source, output, composer_root, component = validate_args(args)
    except Exception as error:
        print(str(error), file=sys.stderr)
        suffix_component = COMPONENT_BY_SUFFIX.get(args.source.suffix.lower(), "unknown")
        return receipt("failed", "WPS_RENDER_FAILED", suffix_component), 1

    if sha256(source) != args.expected_source_sha256:
        print("source content hash did not match the host-provided identity", file=sys.stderr)
        return receipt("failed", "SOURCE_HASH_MISMATCH", component), 1

    try:
        verify_wps_identity(args)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return receipt("dependency_missing", "WPS_RUNTIME_MISSING", component), 1

    fake_pdf_value = os.environ.get("SUPERWAGIE_WPS_FAKE_PDF")
    if fake_pdf_value:
        try:
            published = copy_fake_pdf(Path(fake_pdf_value), output)
            verify_wps_identity(args)
        except Exception as error:
            output.unlink(missing_ok=True)
            print(str(error), file=sys.stderr)
            return receipt("failed", "WPS_RENDER_FAILED", component), 1
        return receipt(
            "success",
            "OK",
            component,
            output_sha256=sha256(published),
        ), 0

    if not composer_root.is_absolute() or not composer_root.resolve().is_dir():
        print("explicit WPSComposer root is unavailable", file=sys.stderr)
        return receipt("dependency_missing", "WPS_RUNTIME_MISSING", component), 1

    try:
        with redirect_stdout(sys.stderr):
            ConversionError, convert_to_pdf, package_root = load_explicit_wpscomposer(
                composer_root
            )
            with ExplicitNamespaceFinder(package_root), spawned_import_scope(
                package_root,
                output.parent,
            ):
                published_value = call_explicit_converter(
                    convert_to_pdf,
                    source,
                    output,
                    args,
                    package_root,
                )
                validate_explicit_namespace(package_root)
                verify_wps_identity(args)
        published = Path(published_value).resolve()
        if published != output or not published.is_file():
            raise RuntimeError("WPSComposer returned an unexpected output")
    except (ImportError, ModuleNotFoundError) as error:
        try:
            output.unlink(missing_ok=True)
        except OSError:
            pass
        print(str(error), file=sys.stderr)
        return receipt("dependency_missing", "WPS_RUNTIME_MISSING", component), 1
    except Exception as error:
        try:
            output.unlink(missing_ok=True)
        except OSError:
            pass
        conversion_type: Any = locals().get("ConversionError")
        if conversion_type is not None and isinstance(error, conversion_type):
            status, code = map_conversion_error(error)
        else:
            status, code = "failed", "WPS_RENDER_FAILED"
        print(str(error), file=sys.stderr)
        return receipt(status, code, component), 1
    finally:
        cleanup_explicit_namespace()

    return receipt(
        "success",
        "OK",
        component,
        output_sha256=sha256(published),
    ), 0


def main() -> int:
    try:
        args = parse_args()
        value, exit_code = render(args)
    except BaseException as error:
        print(str(error), file=sys.stderr)
        value, exit_code = receipt("failed", "WPS_RENDER_FAILED", "unknown"), 1
    emit(value)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
