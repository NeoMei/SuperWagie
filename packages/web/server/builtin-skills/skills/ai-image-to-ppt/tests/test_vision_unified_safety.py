import contextlib
import io
import json
import shutil
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import vision_check_gemini


class UnifiedVisionSafetyTests(unittest.TestCase):
    def test_managed_proxy_stops_before_resolver_and_secret_file_read_in_cli(self):
        for flag in ("OPENCHAMBER_UNIHUB_PROXY_URL", "OPENCHAMBER_UNIHUB_PROXY_TOKEN"):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                image = root / "slide.png"
                Image.new("RGB", (4, 4), "blue").save(image)
                secrets = root / ".secrets"
                secrets.mkdir()
                # Opening this FIFO for reading blocks; a successful bounded CLI exit
                # demonstrates that the legacy secret file was not opened.
                os.mkfifo(secrets / "gemini_api_key")
                marker = root / "resolver-was-started"
                resolver = root / "resolver.py"
                resolver.write_text(
                    "from pathlib import Path\n"
                    + f"Path({str(marker)!r}).write_text('started')\n"
                    + "print('null')\n", encoding="utf-8"
                )
                environment = {
                    "HOME": temp,
                    "OPENCHAMBER_DATA_DIR": temp,
                    "SUPERWAGIE_MODEL_NODE": sys.executable,
                    "SUPERWAGIE_MODEL_RESOLVER": str(resolver),
                    flag: "fixture-private-value",
                }
                result = subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "vision_check_gemini.py"),
                     str(image), "--retries", "0"],
                    env=environment, capture_output=True, text=True, timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("managed vision inspection is not available", result.stderr)
                self.assertNotIn("fixture-private-value", result.stderr)
                self.assertFalse(marker.exists(), "resolver must not be started")

    def test_managed_configuration_never_falls_back_to_gemini_secret(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'slide.png'
            Image.new('RGB', (4, 4), 'blue').save(image)
            resolver = root / 'resolver.py'
            resolver.write_text('import json; print(json.dumps(' + repr({
                'protocol': 'managed-media', 'baseUrl': 'http://127.0.0.1:1',
                'model': 'fixture', 'parameters': {},
            }) + '))', encoding='utf-8')
            environment = {
                'HOME': temp,
                'OPENCHAMBER_DATA_DIR': temp,
                'SUPERWAGIE_MODEL_NODE': sys.executable,
                'SUPERWAGIE_MODEL_RESOLVER': str(resolver),
                'OPENCHAMBER_UNIHUB_PROXY_URL': 'http://127.0.0.1:1',
                'OPENCHAMBER_UNIHUB_PROXY_TOKEN': 'fixture-private-token',
                'GEMINI_API_KEY': 'fixture-legacy-key',
            }
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen, \
                 contextlib.redirect_stderr(stderr):
                self.assertEqual(vision_check_gemini.main([str(image), 'inspect']), 1)
            urlopen.assert_not_called()
            self.assertNotIn('fixture-private-token', stderr.getvalue())
            self.assertNotIn('fixture-legacy-key', stderr.getvalue())

    def test_managed_binding_without_proxy_flags_does_not_read_legacy_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "slide.png"
            Image.new("RGB", (4, 4), "blue").save(image)
            resolver = root / "resolver.py"
            resolver.write_text('import json; print(json.dumps(' + repr({
                'protocol': 'managed-media', 'baseUrl': 'http://127.0.0.1:1',
                'model': 'fixture', 'parameters': {},
            }) + '))', encoding='utf-8')
            environment = {
                'HOME': temp, 'OPENCHAMBER_DATA_DIR': temp,
                'SUPERWAGIE_MODEL_NODE': sys.executable,
                'SUPERWAGIE_MODEL_RESOLVER': str(resolver),
            }
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini, '_load_api_key') as load_key, \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaisesRegex(vision_check_gemini.VisionCheckError, 'managed vision'):
                    vision_check_gemini.check(str(image), retries=0)
            load_key.assert_not_called()
            urlopen.assert_not_called()

    def test_resolver_receives_no_unrelated_credentials_when_proxy_flags_are_absent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "slide.png"
            Image.new("RGB", (4, 4), "blue").save(image)
            observed = root / "environment.json"
            resolver = root / "resolver.py"
            resolver.write_text(
                "import json, os\nfrom pathlib import Path\n"
                + f"Path({str(observed)!r}).write_text(json.dumps(dict(os.environ)))\n"
                + "print(json.dumps({'protocol': 'managed-media', 'baseUrl': 'http://127.0.0.1:1', 'model': 'fixture'}))\n",
                encoding="utf-8",
            )
            environment = {
                'HOME': temp, 'OPENCHAMBER_DATA_DIR': temp,
                'SUPERWAGIE_MODEL_NODE': sys.executable,
                'SUPERWAGIE_MODEL_RESOLVER': str(resolver),
                'GEMINI_API_KEY': 'private-gemini',
                'GOOGLE_API_KEY': 'private-google',
                'OPENAI_API_KEY': 'private-openai',
                'OPENCODE_PASSWORD': 'private-password',
                'ARBITRARY_SECRET': 'private-other',
            }
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini, '_load_api_key') as load_key, \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaisesRegex(vision_check_gemini.VisionCheckError, 'managed vision'):
                    vision_check_gemini.check(str(image), retries=0)
                self.assertEqual(os.environ['GEMINI_API_KEY'], 'private-gemini')
            received = json.loads(observed.read_text())
            for name in ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_PASSWORD', 'ARBITRARY_SECRET'):
                self.assertNotIn(name, received)
            self.assertEqual(received['OPENCHAMBER_DATA_DIR'], temp)
            load_key.assert_not_called()
            urlopen.assert_not_called()

    def test_real_private_resolver_detects_managed_binding_with_restricted_environment(self):
        node = shutil.which('node')
        resolver = ROOT.parents[2] / 'lib' / 'model-configuration' / 'resolve-cli.js'
        if not node or not resolver.exists():
            self.skipTest('private resolver or Node is unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'slide.png'
            Image.new('RGB', (4, 4), 'blue').save(image)
            state = {
                'version': 1, 'revision': 1,
                'connections': [{'id': 'managed', 'name': 'UniHub', 'providerId': 'unihub',
                    'protocol': 'managed-media', 'baseUrl': 'https://llmrouter.example.test/platform/v1'}],
                'bindings': [{'purpose': 'vision', 'connectionId': 'managed', 'model': 'fixture-vision',
                    'parameters': {}, 'verification': {'status': 'untested'}}],
            }
            (root / 'model-configuration.json').write_text(json.dumps(state), encoding='utf-8')
            environment = {'HOME': temp, 'OPENCHAMBER_DATA_DIR': temp,
                'SUPERWAGIE_MODEL_NODE': node, 'SUPERWAGIE_MODEL_RESOLVER': str(resolver),
                'GEMINI_API_KEY': 'private-gemini'}
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini, '_load_api_key') as load_key, \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaisesRegex(vision_check_gemini.VisionCheckError, 'managed vision'):
                    vision_check_gemini.check(str(image), retries=0)
            load_key.assert_not_called()
            urlopen.assert_not_called()

    def test_missing_vision_binding_with_managed_proxy_does_not_fall_back(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'slide.png'
            Image.new('RGB', (4, 4), 'blue').save(image)
            resolver = root / 'resolver.py'
            resolver.write_text('print("null")', encoding='utf-8')
            environment = {
                'HOME': temp,
                'OPENCHAMBER_DATA_DIR': temp,
                'SUPERWAGIE_MODEL_NODE': sys.executable,
                'SUPERWAGIE_MODEL_RESOLVER': str(resolver),
                'OPENCHAMBER_UNIHUB_PROXY_URL': 'http://127.0.0.1:1',
                'OPENCHAMBER_UNIHUB_PROXY_TOKEN': 'fixture-private-token',
                'GEMINI_API_KEY': 'fixture-legacy-key',
            }
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaises(vision_check_gemini.VisionCheckError):
                    vision_check_gemini.check(str(image), retries=0)
            urlopen.assert_not_called()

    def test_unified_configuration_without_resolver_does_not_use_legacy_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'slide.png'
            Image.new('RGB', (4, 4), 'blue').save(image)
            (root / 'model-configuration.json').write_text('{}', encoding='utf-8')
            with mock.patch.dict(os.environ, {'HOME': temp, 'OPENCHAMBER_DATA_DIR': temp, 'GEMINI_API_KEY': 'fixture'}, clear=True), \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaises(vision_check_gemini.VisionCheckError):
                    vision_check_gemini.check(str(image), retries=0)
            urlopen.assert_not_called()

    def test_incomplete_managed_proxy_never_uses_legacy_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'slide.png'
            Image.new('RGB', (4, 4), 'blue').save(image)
            environment = {'HOME': temp, 'OPENCHAMBER_DATA_DIR': temp,
                           'OPENCHAMBER_UNIHUB_PROXY_TOKEN': 'fixture-private-token',
                           'GEMINI_API_KEY': 'fixture-legacy-key'}
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(vision_check_gemini.urllib.request, 'urlopen') as urlopen:
                with self.assertRaises(vision_check_gemini.VisionCheckError):
                    vision_check_gemini.check(str(image), retries=0)
            urlopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
