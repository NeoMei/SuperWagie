import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / 'worker.py'

class ProtocolTests(unittest.TestCase):
    def test_protocol_keeps_utf8_when_windows_pipe_encoding_is_ansi(self):
        environment = dict(os.environ, PYTHONIOENCODING='cp1252')
        messages = [
            {'id': '中文回合🧠', 'method': 'capabilities', 'params': {}},
            {'id': '关闭', 'method': 'close', 'params': {}},
        ]
        process = subprocess.Popen([sys.executable, '-u', str(WORKER)], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        payload = ('\n'.join(json.dumps(message, ensure_ascii=False) for message in messages) + '\n').encode('utf-8')
        out, err = process.communicate(payload, timeout=10)
        self.assertEqual(process.returncode, 0)
        rows = [json.loads(line.decode('utf-8', errors='strict')) for line in out.splitlines()]
        self.assertEqual([row['id'] for row in rows], ['中文回合🧠', '关闭'])
        self.assertTrue(rows[1]['result']['closed'])
        self.assertEqual(err, b'')

    def test_handshake_close_and_eof(self):
        process = subprocess.Popen([sys.executable, '-u', str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        out, err = process.communicate('\n'.join([json.dumps({'id':'one','method':'capabilities','params':{}}), json.dumps({'id':'two','method':'close','params':{}})])+'\n', timeout=10)
        rows = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(process.returncode, 0)
        self.assertEqual(rows[0]['result']['source_sha'], '988667cd876fb80bee6d618482f78a2fe426402c')
        self.assertEqual(rows[1], {'id':'two','result':{'closed':True}})
        self.assertEqual(err, '')

    def test_reverse_rpc_organize_uses_real_core(self):
        from test_engine import context, segment
        process = subprocess.Popen([sys.executable, '-u', str(WORKER)], env=dict(os.environ, PYTHONIOENCODING='cp1252'),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        source = segment(); source['messages'][0]['text'] = '请检查可编辑导出。🧠'
        process.stdin.write(json.dumps({'id':'job','method':'organize','params':{'segment':source,'context':context()}}, ensure_ascii=False)+'\n'); process.stdin.flush()
        final = None
        for _ in range(80):
            row = json.loads(process.stdout.readline())
            if row.get('id') == 'job':
                final = row; break
            self.assertIn(row['method'], ['host.generate','host.embed','host.store'])
            params = row['params']
            if row['method'] == 'host.generate':
                result = {'content': '{"experiences":[],"facts":[{"statement":"WPS export checked","subject":"PPTX"}]}'}
            elif row['method'] == 'host.embed':
                result = {'vectors': [[1.0,0.0] for _ in params['texts']], 'space_id':'test', 'dimensions':2}
            else:
                result = {'nodes':[], 'records':[], 'relations':[], 'total':0}
            process.stdin.write(json.dumps({'id':row['id'],'result':result})+'\n'); process.stdin.flush()
        self.assertTrue(final['result']['facts'])
        self.assertTrue(final['result']['operations'])
        process.stdin.write(json.dumps({'id':'close','method':'close'})+'\n'); process.stdin.flush()
        self.assertTrue(json.loads(process.stdout.readline())['result']['closed'])
        process.stdin.close(); process.wait(timeout=10)
        self.assertEqual(process.stderr.read(), '')
        process.stdout.close(); process.stderr.close()
