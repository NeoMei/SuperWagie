import importlib.util
import json
import os
import struct
import signal
import socket
import subprocess
import sys
import time
import tempfile
import types
import unittest
import zlib
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3] / 'builtin-skills/skills/obsidian-excalidraw'
spec = importlib.util.spec_from_file_location('managed_render', ROOT / 'references/render.py')
render = importlib.util.module_from_spec(spec)
with mock.patch.dict('sys.modules', {'playwright': types.ModuleType('playwright'), 'playwright.sync_api': types.SimpleNamespace(sync_playwright=mock.Mock())}):
    spec.loader.exec_module(render)

def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\0\0\0\xff')) + chunk(b'IEND', b'')

class ManagedRenderTests(unittest.TestCase):
    def test_partial_and_unavailable_binding_never_select_standalone(self):
        for env in [{'SUPERWAGIE_EXCALIDRAW_NODE': '/tmp/node'}, {'SUPERWAGIE_EXCALIDRAW_NODE_MODE':'unavailable'}, {'superwagie_excalidraw_python':'/tmp/python'}]:
            with self.subTest(env=env), self.assertRaisesRegex(RuntimeError, 'managed preview'):
                render._managed_binding(env)
        self.assertIsNone(render._managed_binding({}))

    def test_server_inventory_has_only_renderer_and_fonts(self):
        assets = render._assets()
        self.assertEqual(len(assets), 218)
        self.assertNotIn('/generate.py', assets)
        for value in ['/../render.html', '/%2e%2e/render.html', '/render.html?file=x', '/fonts/../../generate.py']:
            self.assertIsNone(render._asset_request(value, assets))

    def test_failure_and_invalid_png_preserve_prior_output_and_remove_temporary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'图 空间.excalidraw'; out=root/'old.png'
            source.write_text(json.dumps({'elements': []})); out.write_bytes(b'previous')
            for failure in ['render failure', 'invalid png']:
                def preview(job, binding):
                    Path(job['output']).write_bytes(b'incomplete')
                    if failure == 'render failure': raise RuntimeError('render failure')
                    return {'ok':True}
                with mock.patch.object(render, '_preview', preview, create=True), mock.patch.dict(os.environ, {}, clear=True), self.assertRaises((RuntimeError, ValueError)):
                    render.render(source,out)
                self.assertEqual(out.read_bytes(),b'previous')
                self.assertEqual(sorted(p.name for p in root.iterdir()), ['old.png','图 空间.excalidraw'])

    def test_valid_png_is_published_only_after_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'scene.excalidraw'; out=root/'old.png'
            source.write_text(json.dumps({'elements': []})); out.write_bytes(b'previous')
            def preview(job,binding):
                self.assertEqual(out.read_bytes(),b'previous'); Path(job['output']).write_bytes(png()); return {'ok':True}
            with mock.patch.object(render,'_preview',preview,create=True),mock.patch.dict(os.environ,{},clear=True): render.render(source,out)
            self.assertEqual(out.read_bytes(),png())

    def test_linked_output_parent_and_unrelated_hardlink_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'scene'; source.write_text('{"elements":[]}'); target=root/'keep';target.write_bytes(b'keep')
            link=root/'linked';link.symlink_to(root,target_is_directory=True); hard=root/'hard.png';os.link(target,hard)
            for out in [link/'out.png',hard]:
                with self.assertRaises(ValueError): render.render(source,out)
            self.assertEqual(target.read_bytes(),b'keep')

    @unittest.skipIf(os.name == "nt", "POSIX SIGTERM subprocess contract; native Windows is a separate check")
    def test_normal_cli_sigterm_closes_owned_worker_server_and_temporary_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'scene.excalidraw'; out=root/'prior.png'
            source.write_text('{"elements":[]}'); out.write_bytes(b'previous PNG')
            worker=root/'owned-node'; ready=root/'ready.json'; stopped=root/'stopped'
            worker.write_text(f"#!{sys.executable}\n" + """import json,os,signal,sys,time
from pathlib import Path
job=json.load(sys.stdin)
root=Path(job['output']).parent
def stop(_signal,_frame):
    (root/'stopped').write_text('SIGTERM')
    sys.exit(1)
signal.signal(signal.SIGTERM,stop)
(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'origin':job['origin']}))
while True: time.sleep(.1)
""")
            worker.chmod(0o700)
            env={key:value for key,value in os.environ.items() if not key.upper().startswith('SUPERWAGIE_EXCALIDRAW_')}
            env.update(SUPERWAGIE_EXCALIDRAW_NODE=str(worker),SUPERWAGIE_EXCALIDRAW_NODE_MODE='node',
                       SUPERWAGIE_EXCALIDRAW_PLAYWRIGHT=str(root),SUPERWAGIE_EXCALIDRAW_PYTHON=sys.executable)
            child=subprocess.Popen([sys.executable,'-I','-B',str(ROOT/'references/render.py'),str(source),'-o',str(out)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            owned=None
            try:
                deadline=time.monotonic()+10
                while not ready.exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue(ready.exists(),'owned preview worker did not start')
                owned=json.loads(ready.read_text()); child.send_signal(signal.SIGTERM)
                child.communicate(timeout=10)
                self.assertNotEqual(child.returncode,0)
                self.assertTrue(stopped.exists(),'SIGTERM must reach the detached worker before parent exit')
                self.assertEqual(stopped.read_text(),'SIGTERM')
                with self.assertRaises(ProcessLookupError):os.kill(owned['pid'],0)
                self.assertEqual(out.read_bytes(),b'previous PNG')
                self.assertEqual(list(root.glob('.excalidraw-*')),[])
                port=int(owned['origin'].rsplit(':',1)[1])
                with socket.socket() as connection:
                    connection.settimeout(.5)
                    self.assertNotEqual(connection.connect_ex(('127.0.0.1',port)),0)
            finally:
                if child.poll() is None:child.kill();child.communicate(timeout=5)
                if owned:
                    try:os.kill(owned['pid'],signal.SIGTERM)
                    except ProcessLookupError:pass
                    deadline=time.monotonic()+3
                    while time.monotonic()<deadline:
                        try:os.kill(owned['pid'],0)
                        except ProcessLookupError:break
                        time.sleep(.02)

    def test_png_crc_and_pixel_limit_are_checked(self):
        self.assertEqual(render._png_dimensions(png(),32_000_000),(1,1))
        with self.assertRaises(ValueError): render._png_dimensions(png()[:-1]+b'x',32_000_000)
        with self.assertRaises(ValueError): render._png_dimensions(png(),0)

if __name__=='__main__': unittest.main()
