import ast
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[3] / "builtin-skills" / "skills" / "obsidian-excalidraw"


def load_render_module_without_playwright():
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = mock.Mock()
    playwright = types.ModuleType("playwright")
    module_spec = importlib.util.spec_from_file_location(
        "render_under_test",
        REPO_ROOT / "references" / "render.py",
    )
    module = importlib.util.module_from_spec(module_spec)
    with mock.patch.dict(sys.modules, {
        "playwright": playwright,
        "playwright.sync_api": sync_api,
    }):
        module_spec.loader.exec_module(module)
    return module


class RenderTemplateTests(unittest.TestCase):
    def test_renderer_origin_check_cannot_be_bypassed_with_url_userinfo(self):
        render = load_render_module_without_playwright()
        origin = "http://127.0.0.1:43123"

        self.assertTrue(render._request_is_local(f"{origin}/render.html", origin))
        self.assertTrue(render._request_is_local("data:image/png;base64,AA==", origin))
        self.assertFalse(render._request_is_local(
            f"{origin}@evil.example/image.png",
            origin,
        ))
        self.assertFalse(render._request_is_local(
            "https://evil.example/image.png",
            origin,
        ))
        self.assertFalse(render._request_is_local("//evil.example/image.png", origin))
        self.assertFalse(render._request_is_local(
            "blob:https://evil.example/opaque-id",
            origin,
        ))
        self.assertTrue(render._request_is_local(
            f"blob:{origin}/opaque-id",
            origin,
        ))
        self.assertFalse(render._request_is_local("file:///etc/passwd", origin))

    def test_viewport_is_bounded_before_chromium_allocates_scaled_pixels(self):
        render = load_render_module_without_playwright()

        width, height = render._fit_viewport(2400, 12000, 8, 32_000_000)

        self.assertLessEqual(width * height * 8 * 8, 32_000_000)

    def test_renderer_rejects_extreme_geometry_before_starting_browser(self):
        render = load_render_module_without_playwright()
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "scene.excalidraw"
            invalid_elements = (
                {
                    "id": "extreme", "type": "rectangle",
                    "x": 1e308, "y": 0, "width": 10, "height": 10,
                },
                {
                    "id": "extent", "type": "rectangle",
                    "x": 9_999_999, "y": 0, "width": 10, "height": 10,
                },
                {
                    "id": "negative", "type": "rectangle",
                    "x": 0, "y": 0, "width": -10, "height": 10,
                },
            )
            for element in invalid_elements:
                with self.subTest(element=element):
                    source.write_text(
                        json.dumps({"elements": [element]}),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, "safe range"):
                        render.render(source, Path(tmpdir) / "output.png")
            with self.assertRaisesRegex(ValueError, "safe maximum"):
                render.render(source, Path(tmpdir) / "output.png", scale=1000)

    def test_renderer_rejects_oversized_source_before_reading_json(self):
        render = load_render_module_without_playwright()
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "scene.excalidraw"
            source.write_text(json.dumps({"elements": []}), encoding="utf-8")

            with (
                mock.patch.object(render, "MAX_SOURCE_BYTES", 10),
                self.assertRaisesRegex(ValueError, "source file exceeds"),
            ):
                render.render(source, Path(tmpdir) / "output.png")

    def test_renderer_rejects_too_many_active_elements_before_starting_browser(self):
        render = load_render_module_without_playwright()
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "scene.excalidraw"
            source.write_text(json.dumps({
                "elements": [
                    {"id": str(index), "type": "rectangle"}
                    for index in range(10_001)
                ],
            }), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "active elements"):
                render.render(source, Path(tmpdir) / "output.png")

    def test_renderer_rejects_unsafe_output_targets_before_starting_browser(self):
        render = load_render_module_without_playwright()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "scene.excalidraw"
            original = json.dumps({"elements": []})
            source.write_text(original, encoding="utf-8")
            output_directory = root / "output"
            output_directory.mkdir()
            output_link = root / "output-link.png"
            output_link.symlink_to(root / "real-output.png")
            output_hardlink = root / "output-hardlink.png"
            os.link(source, output_hardlink)

            for output, message in (
                (source, "different"),
                (output_directory, "regular file"),
                (output_link, "symbolic link"),
                (output_hardlink, "different"),
            ):
                with self.subTest(output=output), self.assertRaisesRegex(
                    ValueError,
                    message,
                ):
                    render.render(source, output)

            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.assertTrue(output_directory.is_dir())
            self.assertTrue(output_link.is_symlink())

    def test_http_socket_closes_if_server_thread_cannot_start(self):
        render = load_render_module_without_playwright()
        fake_server = mock.Mock()
        fake_server.server_address = ("127.0.0.1", 12345)
        fake_thread = mock.Mock()
        fake_thread.start.side_effect = RuntimeError("simulated thread start failure")

        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "scene.excalidraw"
            source.write_text(json.dumps({"elements": []}), encoding="utf-8")
            with (
                mock.patch.object(
                    render.socketserver,
                    "TCPServer",
                    return_value=fake_server,
                ),
                mock.patch.object(
                    render.threading,
                    "Thread",
                    return_value=fake_thread,
                ),
                self.assertRaisesRegex(RuntimeError, "thread start failure"),
            ):
                render.render(source, Path(tmpdir) / "output.png")

        fake_server.server_close.assert_called_once_with()
        fake_server.shutdown.assert_not_called()

    def test_export_preserves_the_scene_background_color(self):
        template = (REPO_ROOT / "references" / "render.html").read_text(encoding="utf-8")

        self.assertNotIn('viewBackgroundColor: "#ffffff"', template)
        self.assertIn("scene.appState", template)
        self.assertIn("exportWithDarkMode: false", template)

    def test_render_always_closes_its_http_server_and_raises_instead_of_exiting(self):
        source = (REPO_ROOT / "references" / "render.py").read_text(encoding="utf-8")
        module = ast.parse(source)
        render_function = next(
            node for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "render"
        )
        calls = [
            node for node in ast.walk(render_function)
            if isinstance(node, ast.Call)
        ]

        self.assertFalse(any(
            isinstance(call.func, ast.Attribute)
            and isinstance(call.func.value, ast.Name)
            and call.func.value.id == "sys"
            and call.func.attr == "exit"
            for call in calls
        ))
        finally_calls = [
            call.func.attr
            for try_node in ast.walk(render_function)
            if isinstance(try_node, ast.Try)
            for statement in try_node.finalbody
            for call in ast.walk(statement)
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
        ]
        self.assertIn("shutdown", finally_calls)
        self.assertIn("server_close", finally_calls)

    def test_render_and_vendor_dependencies_are_version_pinned(self):
        build_script = (REPO_ROOT / "references" / "build-vendor.sh").read_text(
            encoding="utf-8"
        )
        pyproject = (REPO_ROOT / "references" / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        uv_lock = (REPO_ROOT / "references" / "uv.lock").read_text(encoding="utf-8")
        gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        package = json.loads(
            (REPO_ROOT / "references" / "package.json").read_text(encoding="utf-8")
        )
        package_lock = json.loads(
            (REPO_ROOT / "references" / "package-lock.json").read_text(
                encoding="utf-8"
            )
        )

        self.assertIn("npm ci --include=dev", build_script)
        self.assertEqual(package["dependencies"]["@excalidraw/excalidraw"], "0.18.1")
        self.assertEqual(package["devDependencies"]["esbuild"], "0.28.2")
        self.assertEqual(package_lock["lockfileVersion"], 3)
        self.assertEqual(
            package_lock["packages"][""]["dependencies"], package["dependencies"]
        )
        self.assertEqual(
            package_lock["packages"][""]["devDependencies"],
            package["devDependencies"],
        )
        self.assertIn('"playwright==1.62.0"', pyproject)
        self.assertIn('name = "playwright"\nversion = "1.62.0"', uv_lock)
        self.assertIn("!references/uv.lock", gitignore)

    def test_vendored_renderer_uses_complete_local_generator_fonts(self):
        references = REPO_ROOT / "references"
        template = (references / "render.html").read_text(encoding="utf-8")
        build_script = (references / "build-vendor.sh").read_text(encoding="utf-8")

        self.assertIn("EXCALIDRAW_ASSET_PATH", template)
        self.assertLess(
            template.index("EXCALIDRAW_ASSET_PATH"),
            template.index("import { exportToSvg }"),
        )
        for family, minimum_files in (("Excalifont", 7), ("Xiaolai", 200)):
            font_files = list((references / "fonts" / family).glob("*.woff2"))
            self.assertGreaterEqual(len(font_files), minimum_files, family)
            self.assertIn(f"fonts/{family}", build_script)


class RenderIntegrationTests(unittest.TestCase):
    def test_tall_scene_is_scaled_to_the_renderer_pixel_budget(self):
        renderer_python = REPO_ROOT / "references" / ".venv" / "bin" / "python"
        if not renderer_python.exists():
            self.skipTest("run `cd references && uv sync` for render integration tests")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            spec_path = root / "spec.json"
            scene_path = root / "tall.excalidraw"
            png_path = root / "tall.png"
            spec_path.write_text(json.dumps({
                "title": "\n".join(f"line {index}" for index in range(1000)),
                "nodes": [{"id": "end", "label": "end"}],
                "edges": [],
            }), encoding="utf-8")
            subprocess.run(
                [
                    str(renderer_python), str(REPO_ROOT / "references" / "generate.py"),
                    str(spec_path), "--out", str(scene_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = subprocess.run(
                [
                    str(renderer_python), str(REPO_ROOT / "references" / "render.py"),
                    str(scene_path), "--output", str(png_path), "--scale", "1",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode and "Chromium could not start" in result.stderr:
                self.skipTest("run `uv run playwright install chromium` for render integration tests")
            self.assertEqual(result.returncode, 0, result.stderr)
            header = png_path.read_bytes()[:24]
            width, height = struct.unpack(">II", header[16:24])

        self.assertLessEqual(height, 12000)
        self.assertLessEqual(width * height, 32_000_000)

    def test_renderer_loads_mixed_script_fonts_without_external_requests(self):
        renderer_python = REPO_ROOT / "references" / ".venv" / "bin" / "python"
        if not renderer_python.exists():
            self.skipTest("run `cd references && uv sync` for render integration tests")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            spec_path = root / "spec.json"
            scene_path = root / "mixed.excalidraw"
            png_path = root / "mixed.png"
            spec_path.write_text(json.dumps({
                "title": "Unique Ω Ж あ 한 WWW 中文",
                "nodes": [
                    {"id": "mixed", "label": "Wide WWW 中文"},
                    {"id": "middle", "label": "Middle"},
                    {"id": "last", "label": "Last"},
                ],
                "edges": [
                    {"from": "mixed", "to": "middle"},
                    {"from": "middle", "to": "last"},
                    {"from": "last", "to": "mixed", "label": "cycle"},
                ],
            }), encoding="utf-8")
            subprocess.run(
                [
                    str(renderer_python), str(REPO_ROOT / "references" / "generate.py"),
                    str(spec_path), "--out", str(scene_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = subprocess.run(
                [
                    str(renderer_python), str(REPO_ROOT / "references" / "render.py"),
                    str(scene_path), "--output", str(png_path), "--scale", "1",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode and "Chromium could not start" in result.stderr:
                self.skipTest("run `uv run playwright install chromium` for render integration tests")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(png_path.is_file())
            self.assertNotIn("external requests", result.stderr)

    def test_renderer_rejects_non_positive_scale_before_starting_browser(self):
        renderer_python = REPO_ROOT / "references" / ".venv" / "bin" / "python"
        if not renderer_python.exists():
            self.skipTest("run `cd references && uv sync` for render integration tests")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            scene_path = root / "scene.excalidraw"
            png_path = root / "scene.png"
            scene_path.write_text(json.dumps({
                "type": "excalidraw",
                "elements": [],
                "appState": {},
                "files": {},
            }), encoding="utf-8")
            result = subprocess.run(
                [
                    str(renderer_python),
                    str(REPO_ROOT / "references" / "render.py"),
                    str(scene_path),
                    "--output", str(png_path),
                    "--scale", "0",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("positive", result.stderr)

    def test_png_width_respects_the_renderer_max_width(self):
        renderer_python = REPO_ROOT / "references" / ".venv" / "bin" / "python"
        if not renderer_python.exists():
            self.skipTest("run `cd references && uv sync` for render integration tests")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            spec_path = root / "spec.json"
            scene_path = root / "wide.excalidraw"
            png_path = root / "wide.png"
            spec_path.write_text(json.dumps({
                "nodes": [{"id": "wide", "label": "W" * 1000}],
                "edges": [],
            }), encoding="utf-8")
            subprocess.run(
                [
                    str(renderer_python),
                    str(REPO_ROOT / "references" / "generate.py"),
                    str(spec_path),
                    "--out", str(scene_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = subprocess.run(
                [
                    str(renderer_python),
                    str(REPO_ROOT / "references" / "render.py"),
                    str(scene_path),
                    "--output", str(png_path),
                    "--scale", "1",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode and "Chromium could not start" in result.stderr:
                self.skipTest("run `uv run playwright install chromium` for render integration tests")
            self.assertEqual(result.returncode, 0, result.stderr)
            header = png_path.read_bytes()[:24]
            width, _ = struct.unpack(">II", header[16:24])

        self.assertLessEqual(width, 2400)


if __name__ == "__main__":
    unittest.main()
