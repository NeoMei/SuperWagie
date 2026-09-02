from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER = Path(__file__).with_name("wps-render-worker.py")
FIXTURE_PDF = (
    REPO_ROOT
    / "fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf"
)
WPSCOMPOSER_ROOT = Path("/Users/neomei/项目/codexprojects/WpsComposer")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fake_target_contract(source: Path, composer_root: Path) -> tuple[Path, dict[str, str], str]:
    target = source.parent / "fake-wps.exe"
    target.write_bytes(b"controlled-fake-wps-target")
    bridge_relative = "skills/WPSComposer/__init__.py"
    bridge = composer_root / bridge_relative
    manifest = [{"identity": "application-executable", "sha256": sha256(target)}]
    bridge_sha = sha256(bridge) if bridge.is_file() else "0" * 64
    identity = {
        "target_kind": "windows-executable",
        "executable_sha256": sha256(target),
        "bundle_manifest_sha256": hashlib.sha256(
            json.dumps(manifest, separators=(",", ":")).encode()
        ).hexdigest(),
        "bridge_sha256": bridge_sha,
    }
    return target, identity, bridge_relative


def direct_worker_args(source: Path, output: Path, composer_root: Path) -> SimpleNamespace:
    target, identity, bridge_relative = fake_target_contract(source, composer_root)
    return SimpleNamespace(
        source=source,
        output=output,
        wpscomposer_root=composer_root,
        expected_source_sha256=sha256(source),
        deadline_ms=5000,
        wps_application=target,
        expected_wps_identity_json=json.dumps(identity, separators=(",", ":")),
        wps_bridge_relative_path=bridge_relative,
        wps_executable_relative_path=None,
    )


def run_worker(
    source: Path,
    output: Path,
    *,
    composer_root: Path = WPSCOMPOSER_ROOT,
    expected_source_hash: str | None = None,
    fake_pdf: Path | None = None,
    extra_env: dict[str, str] | None = None,
    wps_application: Path | None = None,
    expected_wps_identity: dict[str, str] | None = None,
    bridge_relative_path: str | None = None,
) -> tuple[dict[str, object], subprocess.CompletedProcess[str]]:
    expected_source_hash = expected_source_hash or sha256(source)
    env = os.environ.copy()
    if fake_pdf is None:
        env.pop("SUPERWAGIE_WPS_FAKE_PDF", None)
    else:
        env["SUPERWAGIE_WPS_FAKE_PDF"] = str(fake_pdf)
    if extra_env:
        env.update(extra_env)
    if wps_application is None or expected_wps_identity is None or bridge_relative_path is None:
        wps_application, expected_wps_identity, bridge_relative_path = fake_target_contract(source, composer_root)
    completed = subprocess.run(
        [
            sys.executable,
            str(WORKER),
            "--source",
            str(source),
            "--output",
            str(output),
            "--wpscomposer-root",
            str(composer_root),
            "--expected-source-sha256",
            expected_source_hash,
            "--deadline-ms",
            "5000",
            "--wps-application",
            str(wps_application),
            "--expected-wps-identity-json",
            json.dumps(expected_wps_identity, separators=(",", ":")),
            "--wps-bridge-relative-path",
            bridge_relative_path,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    stdout_lines = completed.stdout.splitlines()
    assert len(stdout_lines) == 1, (
        f"worker must emit exactly one stdout JSON object; "
        f"stdout={completed.stdout!r}, stderr={completed.stderr!r}"
    )
    return json.loads(stdout_lines[0]), completed


def write_source(tmp_path: Path, suffix: str = ".docx") -> Path:
    source = tmp_path / f"host-private-source{suffix}"
    source.write_bytes(b"audited-office-source")
    return source


def load_worker_module() -> object:
    spec = importlib.util.spec_from_file_location(
        "_superwagie_wps_render_worker_test",
        WORKER,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_composer_root(tmp_path: Path, error_code: str, message: str) -> Path:
    root = tmp_path / f"composer-{error_code.lower()}"
    package = root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (root / "skills/__init__.py").write_text("", encoding="utf-8")
    (package / "__init__.py").write_text(
        """
class ConversionError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message
        self.component = "writer"
        self.backend = "fake-wps"

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    print("dependency diagnostic from stdout")
    raise ConversionError(%r, %r)
"""
        % (error_code, message),
        encoding="utf-8",
    )
    return root


def macos_symlink_target_contract(
    worker: object,
    tmp_path: Path,
) -> tuple[Path, Path, SimpleNamespace, Path]:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    application = tmp_path / "WPS.app"
    runtime = application / "Contents/Shared/runtime.dat"
    executable = application / "Contents/MacOS/wps"
    resources = application / "Contents/Resources"
    composer_root = tmp_path / "mac-target-aware-composer"
    package = composer_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    executable.parent.mkdir(parents=True)
    resources.mkdir(parents=True)
    runtime.parent.mkdir(parents=True)
    executable.write_bytes(b"fake-wps-binary")
    runtime.write_bytes(b"runtime-v1")
    (resources / "runtime.dat").symlink_to("../Shared/runtime.dat")
    (application / "Contents/Info.plist").write_text(
        "<plist><dict><key>CFBundleShortVersionString</key><string>12.1</string></dict></plist>",
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        """
from pathlib import Path
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    shutil.copyfile(%r, output)
    Path(wps_application).joinpath("Contents/Shared/runtime.dat").write_bytes(b"runtime-v2")
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )
    args = SimpleNamespace(
        source=source,
        output=output,
        wpscomposer_root=composer_root,
        expected_source_sha256=sha256(source),
        deadline_ms=5000,
        wps_application=application,
        expected_wps_identity_json=json.dumps(
            {
                "target_kind": "macos-app-bundle",
                "executable_sha256": "1" * 64,
                "bundle_manifest_sha256": "2" * 64,
                "bridge_sha256": "3" * 64,
            },
            separators=(",", ":"),
        ),
        wps_bridge_relative_path="skills/WPSComposer/__init__.py",
        wps_executable_relative_path="Contents/MacOS/wps",
    )
    measured = worker.measured_wps_identity(args)
    args.expected_wps_identity_json = json.dumps(measured, separators=(",", ":"))
    return source, output, args, runtime


def legacy_macos_target_contract(
    worker: object,
    tmp_path: Path,
) -> tuple[Path, Path, SimpleNamespace]:
    source = write_source(tmp_path)
    output = tmp_path / "legacy-preview.pdf"
    application = tmp_path / "WPS.app"
    executable = application / "Contents/MacOS/wps"
    executable.parent.mkdir(parents=True)
    (application / "Contents/Resources").mkdir(parents=True)
    executable.write_bytes(b"legacy-explicit-wps-binary")
    (application / "Contents/Info.plist").write_text(
        "<plist><dict><key>CFBundleShortVersionString</key><string>12.1</string></dict></plist>",
        encoding="utf-8",
    )
    composer_root = tmp_path / "legacy-composer"
    package = composer_root / "skills/WPSComposer"
    runtime_package = package / "scripts/macos_probe"
    runtime_package.mkdir(parents=True)
    (package / "scripts/__init__.py").write_text("", encoding="utf-8")
    (runtime_package / "__init__.py").write_text("", encoding="utf-8")
    (runtime_package / "runtime.py").write_text(
        "from pathlib import Path\nWPS_APP = Path(%r)\n" % str(application),
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        """
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False):
    shutil.copyfile(%r, output)
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )
    args = SimpleNamespace(
        source=source,
        output=output,
        wpscomposer_root=composer_root,
        expected_source_sha256=sha256(source),
        deadline_ms=5000,
        wps_application=application,
        expected_wps_identity_json=json.dumps(
            {
                "target_kind": "macos-app-bundle",
                "executable_sha256": "1" * 64,
                "bundle_manifest_sha256": "2" * 64,
                "bridge_sha256": "3" * 64,
            },
            separators=(",", ":"),
        ),
        wps_bridge_relative_path="skills/WPSComposer/__init__.py",
        wps_executable_relative_path="Contents/MacOS/wps",
    )
    args.expected_wps_identity_json = json.dumps(
        worker.measured_wps_identity(args), separators=(",", ":")
    )
    return source, output, args


def test_legacy_macos_converter_is_allowed_only_after_exact_runtime_binding(
    tmp_path: Path,
) -> None:
    worker = load_worker_module()
    _source, output, args = legacy_macos_target_contract(worker, tmp_path)

    value, exit_code = worker.render(args)

    assert exit_code == 0
    assert value["status"] == "success"
    assert value["code"] == "OK"
    assert output.is_file()
    assert sha256(output) == sha256(FIXTURE_PDF)


def test_isolated_macos_runtime_owns_only_the_new_wps_identity() -> None:
    worker = load_worker_module()
    worker.WPS_OWNERSHIP_STABILITY_SECONDS = 0.01
    worker.WPS_OWNERSHIP_CLEANUP_SECONDS = 0.2
    commands: list[list[str]] = []
    existing = SimpleNamespace(pid=101)
    created = SimpleNamespace(pid=202)
    replacement = SimpleNamespace(pid=303)
    snapshots = [
        {existing.pid: existing, created.pid: created},
        {existing.pid: existing, created.pid: created},
        {existing.pid: existing, replacement.pid: replacement},
        {existing.pid: existing},
    ]

    runtime = SimpleNamespace()

    def activation_command(app: Path, fixture: Path, *, reuse_running: bool = True) -> list[str]:
        return ["open", "-a" if reuse_running else "-n", str(app), str(fixture)]

    class ProbeRuntime:
        def __init__(self) -> None:
            self.wps_app = Path("/Applications/WPS.app")
            self.deadline = time.monotonic() + 1
            self._wps_processes_before = {existing.pid: existing}
            self._owned_wps_processes: dict[int, object] = {}

        def activate_component(self, component: str, *, deadline: float | None = None) -> Path:
            commands.append(runtime.activation_command(self.wps_app, Path(f"/{component}.docx")))
            return Path(f"/{component}.docx")

        def close(self) -> None:
            self.closed_owned = dict(self._owned_wps_processes)
            self._owned_wps_processes.clear()

        def _terminate_owned_wps(self, _deadline: float | None = None) -> None:
            self.terminated_owned = {
                **getattr(self, "terminated_owned", {}),
                **self._owned_wps_processes,
            }
            self._owned_wps_processes.clear()

    runtime.ProbeRuntime = ProbeRuntime
    runtime.activation_command = activation_command
    runtime.list_wps_processes = lambda _app, timeout=1: (
        snapshots.pop(0) if snapshots else {existing.pid: existing}
    )
    runtime.owned_wps_pids = lambda before, after: after - before
    runtime_factories: list[object] = []

    def convert_macos(_request: object, *, runtime_factory: object | None = None) -> None:
        runtime_factories.append(runtime_factory)

    conversion = SimpleNamespace(
        ProbeRuntime=ProbeRuntime,
        convert_macos=convert_macos,
    )

    with worker.isolated_macos_runtime_scope(runtime, conversion):
        conversion.convert_macos(object())
        assert runtime_factories == [conversion.ProbeRuntime]
        probe = conversion.ProbeRuntime()
        probe.activate_component("writer", deadline=probe.deadline)
        assert commands == [["open", "-n", "/Applications/WPS.app", "/writer.docx"]]
        assert probe._owned_wps_processes == {created.pid: created}
        probe.close()
        assert probe.closed_owned == {created.pid: created}
        assert probe.terminated_owned == {replacement.pid: replacement}
        assert existing.pid not in probe.closed_owned
        assert existing.pid not in probe.terminated_owned

    assert conversion.ProbeRuntime is ProbeRuntime
    assert conversion.convert_macos is convert_macos
    assert runtime.activation_command is activation_command


def test_explicit_probed_target_reaches_bridge_and_replacement_is_rejected(
    tmp_path: Path,
) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    composer_root = tmp_path / "target-aware-composer"
    package = composer_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    marker = tmp_path / "received-target.txt"
    (package / "__init__.py").write_text(
        """
from pathlib import Path
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    Path(%r).write_text(wps_application, encoding="utf-8")
    shutil.copyfile(%r, output)
    return output
"""
        % (str(marker), str(FIXTURE_PDF)),
        encoding="utf-8",
    )
    target, identity, bridge_relative = fake_target_contract(source, composer_root)

    receipt, completed = run_worker(
        source,
        output,
        composer_root=composer_root,
        wps_application=target,
        expected_wps_identity=identity,
        bridge_relative_path=bridge_relative,
    )

    assert completed.returncode == 0, completed.stderr
    assert receipt["status"] == "success"
    assert marker.read_text(encoding="utf-8") == str(target.resolve())

    target.write_bytes(b"replacement-target")
    output.unlink()
    receipt, completed = run_worker(
        source,
        output,
        composer_root=composer_root,
        wps_application=target,
        expected_wps_identity=identity,
        bridge_relative_path=bridge_relative,
    )
    assert completed.returncode != 0
    assert receipt["code"] == "WPS_RUNTIME_MISSING"
    assert not output.exists()

    (package / "__init__.py").write_text(
        """
from pathlib import Path
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    shutil.copyfile(%r, output)
    Path(wps_application).write_bytes(b"replaced-during-render")
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )
    target, identity, bridge_relative = fake_target_contract(source, composer_root)
    receipt, completed = run_worker(
        source,
        output,
        composer_root=composer_root,
        wps_application=target,
        expected_wps_identity=identity,
        bridge_relative_path=bridge_relative,
    )
    assert completed.returncode != 0
    assert receipt["code"] == "WPS_RENDER_FAILED"
    assert not output.exists()


def test_macos_relative_symlink_target_mutation_changes_identity_and_blocks_pre_post_replacement(
    tmp_path: Path,
) -> None:
    worker = load_worker_module()
    _source, output, args, runtime = macos_symlink_target_contract(worker, tmp_path)
    expected = json.loads(args.expected_wps_identity_json)

    runtime.write_bytes(b"runtime-pre-replaced")
    assert worker.measured_wps_identity(args) != expected
    pre_value, pre_exit = worker.render(args)
    assert pre_exit != 0
    assert pre_value["code"] == "WPS_RUNTIME_MISSING"
    assert not output.exists()

    runtime.write_bytes(b"runtime-v1")
    post_value, post_exit = worker.render(args)
    assert post_exit != 0
    assert post_value["code"] == "WPS_RENDER_FAILED"
    assert not output.exists()


def test_current_wpscomposer_without_explicit_target_api_fails_closed(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    receipt, completed = run_worker(
        source,
        tmp_path / "preview.pdf",
        composer_root=WPSCOMPOSER_ROOT,
    )
    assert completed.returncode != 0
    assert receipt["status"] == "dependency_missing"
    assert receipt["code"] == "WPS_RUNTIME_MISSING"


def test_success_receipt_contains_no_host_or_staging_path(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "staging" / "job-private" / "preview.pdf"
    output.parent.mkdir(parents=True)

    receipt, completed = run_worker(source, output, fake_pdf=FIXTURE_PDF)

    assert completed.returncode == 0
    assert receipt == {
        "status": "success",
        "code": "OK",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
        "output_sha256": sha256(FIXTURE_PDF),
    }
    serialized = json.dumps(receipt, sort_keys=True)
    assert str(source) not in serialized
    assert str(output) not in serialized
    assert "staging" not in serialized.lower()


def test_fake_seam_rejects_same_named_but_unaudited_pdf(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    fake_pdf = tmp_path / "reviewer-torture-100p.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4\nnot-the-audited-fixture\n")
    output = tmp_path / "preview.pdf"

    receipt, completed = run_worker(source, output, fake_pdf=fake_pdf)

    assert completed.returncode != 0
    assert receipt == {
        "status": "failed",
        "code": "WPS_RENDER_FAILED",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert not output.exists()


def test_missing_wps_is_dependency_missing(tmp_path: Path) -> None:
    source = write_source(tmp_path)

    receipt, completed = run_worker(
        source,
        tmp_path / "preview.pdf",
        composer_root=tmp_path / "missing",
    )

    assert completed.returncode != 0
    assert receipt == {
        "status": "dependency_missing",
        "code": "WPS_RUNTIME_MISSING",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }


def test_empty_explicit_root_cannot_fall_through_to_discoverable_package(
    tmp_path: Path,
) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    explicit_root = tmp_path / "explicit-empty"
    explicit_root.mkdir()
    alternative_root = tmp_path / "alternative"
    package = alternative_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        """
import shutil

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    shutil.copyfile(%r, output)
    return output

class ConversionError(RuntimeError):
    pass
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )

    receipt, completed = run_worker(
        source,
        output,
        composer_root=explicit_root,
        extra_env={"PYTHONPATH": str(alternative_root)},
    )

    assert completed.returncode != 0
    assert receipt == {
        "status": "dependency_missing",
        "code": "WPS_RUNTIME_MISSING",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert not output.exists()


def test_explicit_package_rejects_relative_child_symlink_escape(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        "from .escaped import ConversionError, convert_to_pdf\n",
        encoding="utf-8",
    )
    outside = tmp_path / "outside"
    outside.mkdir()
    escaped_module = outside / "escaped.py"
    escaped_module.write_text(
        """
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    shutil.copyfile(%r, output)
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )
    (package / "escaped.py").symlink_to(escaped_module)

    receipt, completed = run_worker(source, output, composer_root=explicit_root)

    assert completed.returncode != 0
    assert receipt == {
        "status": "dependency_missing",
        "code": "WPS_RUNTIME_MISSING",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert not output.exists()


def test_explicit_package_accepts_regular_root_local_relative_child(
    tmp_path: Path,
) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        "from .local_converter import ConversionError, convert_to_pdf\n",
        encoding="utf-8",
    )
    (package / "local_converter.py").write_text(
        """
import shutil

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    shutil.copyfile(%r, output)
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )

    receipt, completed = run_worker(source, output, composer_root=explicit_root)

    assert completed.returncode == 0
    assert receipt == {
        "status": "success",
        "code": "OK",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
        "output_sha256": sha256(FIXTURE_PDF),
    }
    assert sha256(output) == sha256(FIXTURE_PDF)


def test_explicit_package_remains_importable_in_spawned_validation_child(
    tmp_path: Path,
) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "child_validation.py").write_text(
        """
def report_module(connection):
    connection.send(__name__)
    connection.close()
""",
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        """
import multiprocessing
import shutil
from .child_validation import report_module

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    child = context.Process(target=report_module, args=(sender,))
    child.start()
    sender.close()
    module_name = receiver.recv()
    receiver.close()
    child.join(timeout=5)
    if child.exitcode != 0:
        raise RuntimeError("spawned validation child failed")
    if module_name != __package__ + ".child_validation":
        raise RuntimeError("spawned validation child imported another package")
    shutil.copyfile(%r, output)
    return output
"""
        % str(FIXTURE_PDF),
        encoding="utf-8",
    )

    receipt, completed = run_worker(source, output, composer_root=explicit_root)

    assert completed.returncode == 0, completed.stderr
    assert receipt["status"] == "success"
    assert receipt["code"] == "OK"
    assert sha256(output) == sha256(FIXTURE_PDF)


def test_converter_lazy_relative_child_symlink_escape_fails_before_execution(
    tmp_path: Path,
) -> None:
    worker = load_worker_module()
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    execution_marker = tmp_path / "outside-module-executed"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        """
class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    from .escaped import publish
    return publish(output)
""",
        encoding="utf-8",
    )
    outside = tmp_path / "outside"
    outside.mkdir()
    escaped_module = outside / "escaped.py"
    escaped_module.write_text(
        """
from pathlib import Path
import shutil

Path(%r).write_text("executed", encoding="utf-8")

def publish(output):
    shutil.copyfile(%r, output)
    return output
"""
        % (str(execution_marker), str(FIXTURE_PDF)),
        encoding="utf-8",
    )
    (package / "escaped.py").symlink_to(escaped_module)

    value, exit_code = worker.render(direct_worker_args(source, output, explicit_root))

    assert exit_code != 0
    assert value == {
        "status": "dependency_missing",
        "code": "WPS_RUNTIME_MISSING",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert not execution_marker.exists()
    assert not output.exists()
    assert not any(
        name == worker.EXPLICIT_MODULE_NAME
        or name.startswith(f"{worker.EXPLICIT_MODULE_NAME}.")
        for name in sys.modules
    )
    assert not any(
        isinstance(finder, worker.ExplicitNamespaceFinder) for finder in sys.meta_path
    )


def test_converter_lazy_relative_child_accepts_regular_root_local_module(
    tmp_path: Path,
) -> None:
    worker = load_worker_module()
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    execution_marker = tmp_path / "local-module-executed"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        """
class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    from .local_lazy import publish
    return publish(output)
""",
        encoding="utf-8",
    )
    (package / "local_lazy.py").write_text(
        """
from pathlib import Path
import shutil

Path(%r).write_text("executed", encoding="utf-8")

def publish(output):
    shutil.copyfile(%r, output)
    return output
"""
        % (str(execution_marker), str(FIXTURE_PDF)),
        encoding="utf-8",
    )

    value, exit_code = worker.render(direct_worker_args(source, output, explicit_root))

    assert exit_code == 0
    assert value == {
        "status": "success",
        "code": "OK",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
        "output_sha256": sha256(FIXTURE_PDF),
    }
    assert execution_marker.read_text(encoding="utf-8") == "executed"
    assert sha256(output) == sha256(FIXTURE_PDF)
    assert not any(
        name == worker.EXPLICIT_MODULE_NAME
        or name.startswith(f"{worker.EXPLICIT_MODULE_NAME}.")
        for name in sys.modules
    )
    assert not any(
        isinstance(finder, worker.ExplicitNamespaceFinder) for finder in sys.meta_path
    )


def test_converter_private_namespace_registration_bypass_fails_closed(
    tmp_path: Path,
) -> None:
    worker = load_worker_module()
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"
    execution_marker = tmp_path / "bypass-module-executed"
    explicit_root = tmp_path / "explicit-root"
    package = explicit_root / "skills/WPSComposer"
    package.mkdir(parents=True)
    outside_module = tmp_path / "outside-bypass.py"
    outside_module.write_text(
        """
from pathlib import Path
import shutil

Path(%r).write_text("executed", encoding="utf-8")

def publish(output):
    shutil.copyfile(%r, output)
    return output
"""
        % (str(execution_marker), str(FIXTURE_PDF)),
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        """
import importlib.util
import sys

class ConversionError(RuntimeError):
    pass

def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    name = __package__ + ".registered_bypass"
    spec = importlib.util.spec_from_file_location(name, %r)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module.publish(output)
"""
        % str(outside_module),
        encoding="utf-8",
    )

    value, exit_code = worker.render(direct_worker_args(source, output, explicit_root))

    assert exit_code != 0
    assert value == {
        "status": "dependency_missing",
        "code": "WPS_RUNTIME_MISSING",
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert execution_marker.read_text(encoding="utf-8") == "executed"
    assert not output.exists()
    assert not any(
        name == worker.EXPLICIT_MODULE_NAME
        or name.startswith(f"{worker.EXPLICIT_MODULE_NAME}.")
        for name in sys.modules
    )
    assert not any(
        isinstance(finder, worker.ExplicitNamespaceFinder) for finder in sys.meta_path
    )


def test_source_hash_mismatch_fails_before_conversion(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "preview.pdf"

    receipt, completed = run_worker(
        source,
        output,
        expected_source_hash="0" * 64,
        fake_pdf=FIXTURE_PDF,
    )

    assert completed.returncode != 0
    assert receipt["status"] == "failed"
    assert receipt["code"] == "SOURCE_HASH_MISMATCH"
    assert receipt["component"] == "writer"
    assert "output_sha256" not in receipt
    assert not output.exists()


@pytest.mark.parametrize(
    ("suffix", "component"),
    [
        (".doc", "writer"),
        (".docx", "writer"),
        (".ppt", "presentation"),
        (".pptx", "presentation"),
        (".xls", "spreadsheet"),
        (".xlsx", "spreadsheet"),
    ],
)
def test_extension_maps_to_typed_wps_component(
    tmp_path: Path, suffix: str, component: str
) -> None:
    source = write_source(tmp_path, suffix)

    receipt, completed = run_worker(
        source, tmp_path / f"{component}.pdf", fake_pdf=FIXTURE_PDF
    )

    assert completed.returncode == 0
    assert receipt["component"] == component


@pytest.mark.parametrize(
    ("dependency_code", "message", "status", "public_code"),
    [
        ("BACKEND_UNAVAILABLE", "WPS is unavailable", "dependency_missing", "WPS_RUNTIME_MISSING"),
        ("INTERACTIVE_INPUT_REQUIRED", "A modal is open", "failed", "WPS_INTERACTIVE_INPUT_REQUIRED"),
        ("CONVERSION_COMMAND_FAILED", "Timed out waiting for WPS", "failed", "WPS_RENDER_TIMEOUT"),
        ("FINAL_ARTIFACT_INVALID", "PDF validation failed", "failed", "WPS_RENDER_FAILED"),
    ],
)
def test_conversion_errors_have_stable_public_mapping_and_one_stdout_json(
    tmp_path: Path,
    dependency_code: str,
    message: str,
    status: str,
    public_code: str,
) -> None:
    source = write_source(tmp_path)
    composer_root = fake_composer_root(tmp_path, dependency_code, message)

    receipt, completed = run_worker(
        source, tmp_path / "preview.pdf", composer_root=composer_root
    )

    assert completed.returncode != 0
    assert receipt == {
        "status": status,
        "code": public_code,
        "component": "writer",
        "backend": "wpscomposer-explicit-source",
    }
    assert "dependency diagnostic from stdout" not in completed.stdout
    assert "dependency diagnostic from stdout" in completed.stderr
