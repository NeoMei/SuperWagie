import importlib
import io
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
credentials = importlib.import_module('provider_credentials')


class SharedModelBindingTests(unittest.TestCase):
    def test_resolves_model_privately_and_uses_provider_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            resolver = Path(directory) / 'resolve.js'
            binding = {'protocol': 'aliyun', 'model': 'qwen-image-model', 'apiKey': 'fixture-private-key', 'baseUrl': 'https://workspace.cn-beijing.maas.aliyuncs.com', 'parameters': {}}
            resolver.write_text('process.stdout.write(JSON.stringify(' + json.dumps(binding) + '));')
            with patch.dict(os.environ, {'SUPERWAGIE_MODEL_RESOLVER': str(resolver), 'SUPERWAGIE_MODEL_NODE': 'node'}, clear=False):
                actual = credentials.configured_image_binding('openai')
                self.assertEqual(actual['model'], 'qwen-image-model')
                self.assertEqual(actual['apiKey'], 'fixture-private-key')
                self.assertEqual(credentials.image_endpoint(actual, 'openai'), 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations')
                with self.assertRaises(credentials.APIKeyError):
                    credentials.configured_image_binding('doubao')

    def test_openai_adapter_sends_configured_endpoint_key_and_model(self):
        generator = importlib.import_module('gen_slide_openai')
        image = io.BytesIO()
        Image.new('RGB', (160, 90), 'navy').save(image, format='PNG')
        response = json.dumps({'data': [{'b64_json': base64.b64encode(image.getvalue()).decode()}]}).encode()
        class Response:
            def __init__(self): self.stream = io.BytesIO(response)
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size=-1): return self.stream.read(size)
        binding = {'protocol': 'openai-compatible', 'model': 'selected-image', 'apiKey': 'fixture-image-key', 'baseUrl': 'https://configured.example/v1', 'parameters': {}}
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory, 'slide.png'))
            with patch.object(generator, 'configured_image_binding', return_value=binding), patch.object(generator, 'open_provider_request', return_value=Response()) as send:
                result = generator.generate_result('slide', target, retries=0)
            self.assertTrue(result.ok)
            request = send.call_args.args[0]
            self.assertEqual(request.full_url, 'https://configured.example/v1/images/generations')
            self.assertEqual(request.get_header('Authorization'), 'Bearer fixture-image-key')
            self.assertEqual(json.loads(request.data)['model'], 'selected-image')

    def test_authenticated_image_requests_never_follow_cross_origin_redirects(self):
        private_key = 'fixture-private-redirect-key'
        forwarded = []
        received = []
        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                forwarded.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()
            do_POST = do_GET
            def log_message(self, *args): pass
        target = ThreadingHTTPServer(('127.0.0.1', 0), Target)
        class Source(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(dict(self.headers))
                self.rfile.read(int(self.headers.get('content-length', '0')))
                self.send_response(source.redirect_status)
                self.send_header('Location', f'http://localhost:{target.server_port}/untrusted?private=provider-body-marker')
                self.send_header('Content-Length', '0')
                self.end_headers()
            def log_message(self, *args): pass
        source = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        workers = [threading.Thread(target=server.serve_forever, daemon=True) for server in (target, source)]
        for worker in workers: worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                for status in (301, 302, 303, 307, 308):
                    source.redirect_status = status
                    for engine, protocol in (('openai', 'openai-compatible'), ('gemini', 'gemini'), ('doubao', 'volcengine')):
                        with self.subTest(status=status, engine=engine):
                            module = importlib.import_module('gen_slide_' + engine)
                            binding = {'protocol': protocol, 'model': 'selected-image', 'apiKey': private_key, 'baseUrl': f'http://127.0.0.1:{source.server_port}/v1', 'parameters': {}}
                            with patch.object(module, 'configured_image_binding', return_value=binding):
                                result = module.generate_result('slide', str(Path(directory, f'{engine}-{status}.png')), retries=0)
                            self.assertFalse(result.ok)
                            self.assertEqual(result.safe_message, 'provider redirects are not supported')
                            self.assertNotIn(private_key, result.safe_message)
                            self.assertNotIn('provider-body-marker', result.safe_message)
            self.assertEqual(len(received), 15)
            self.assertEqual(forwarded, [])
        finally:
            for server in (source, target):
                server.shutdown()
                server.server_close()
            for worker in workers: worker.join()

    def test_legacy_environment_remains_when_no_managed_configuration_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {'OPENCHAMBER_DATA_DIR': directory}, clear=True):
                self.assertIsNone(credentials.load_model_binding('image-generation', ('openai-compatible',)))

    def test_missing_runtime_does_not_silently_use_an_unrelated_legacy_key(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'model-configuration.json').write_text('{}')
            with patch.dict(os.environ, {'OPENCHAMBER_DATA_DIR': directory}, clear=True):
                with self.assertRaises(credentials.APIKeyError):
                    credentials.load_model_binding('image-generation', ('openai-compatible',))

    def test_failed_resolver_does_not_include_its_private_output_in_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            resolver = Path(directory) / 'resolve.js'
            resolver.write_text("console.log('private-key'); process.exit(1);")
            with patch.dict(os.environ, {'SUPERWAGIE_MODEL_RESOLVER': str(resolver), 'SUPERWAGIE_MODEL_NODE': 'node'}, clear=False):
                with self.assertRaises(credentials.APIKeyError) as result:
                    credentials.load_model_binding('image-generation', ('openai-compatible',))
                self.assertNotIn('private-key', str(result.exception))


if __name__ == '__main__':
    unittest.main()
