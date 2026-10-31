"""Offline contracts for SuperWagie's self-contained WPS resources."""

from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from skills.WPSComposer.scripts.runtime_paths import macos_probe_root, template_resource_dir
from skills.WPSComposer.scripts.macos_probe.runtime import ProbeRuntime
from skills.WPSComposer.scripts.macos_probe.templates import (
    TEMPLATES, clone_template, clone_activation_document, verify_addin_assets,
)


class BundledRuntimeTests(unittest.TestCase):
    def test_resources_resolve_within_the_installed_skill(self):
        root = Path(__file__).resolve().parents[1]
        probe = macos_probe_root()
        self.assertEqual(probe, root / "runtime" / "macos" / "wps-jsapi-probe")
        self.assertTrue(template_resource_dir(probe).is_relative_to(probe))
        self.assertFalse((probe / "node_modules").exists())
        verify_addin_assets(probe / "addin")

    def test_all_pinned_templates_validate_and_clone_without_npm(self):
        with TemporaryDirectory() as directory:
            staging = Path(directory)
            for component in TEMPLATES:
                with self.subTest(component=component):
                    output = clone_template(macos_probe_root(), staging, component)
                    self.assertTrue(output.is_file())
            activation = staging / "activation"
            activation.mkdir()
            self.assertTrue(clone_activation_document(macos_probe_root(), activation, "writer").is_file())

    def test_profiles_prepare_offline_without_starting_wps_or_servers(self):
        with TemporaryDirectory() as directory:
            runtime = ProbeRuntime(macos_probe_root(), Path(directory), "http://127.0.0.1:12345", "test-only-capability")
            profiles = runtime.prepare_profiles()
            self.assertEqual(set(profiles), {"writer", "presentation", "spreadsheet"})
            for profile in profiles.values():
                self.assertTrue((profile / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()
