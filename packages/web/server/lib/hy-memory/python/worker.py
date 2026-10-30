#!/usr/bin/env python3
"""Private JSON-lines worker. Node owns process lifecycle and durable commits."""
import asyncio
import json
import logging
import sys
import warnings
import threading

# JSON lines are UTF-8 even when Windows redirects pipes using an ANSI code page.
sys.stdin.reconfigure(encoding='utf-8', errors='strict')
sys.stdout.reconfigure(encoding='utf-8', errors='strict', newline='\n', write_through=True)

logging.disable(logging.CRITICAL)
warnings.filterwarnings('ignore', category=SyntaxWarning)
from engine import HyEngine

# Windows native-library initialization can inspect stdin while the pipe reader
# holds a blocking read. Load the required numeric modules before that thread.
if sys.platform == 'win32':
    import importlib
    for module in ('numpy', 'sklearn.cluster', 'sklearn.metrics.pairwise'):
        importlib.import_module(module)

MAX_LINE = 8 * 1024 * 1024


class Worker:
    def __init__(self):
        self.pending = {}
        self.sequence = 0
        self.requests = asyncio.Queue()
        self.engine = HyEngine(self.host)
        self.closed = False

    def emit(self, value):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        if len(encoded.encode('utf-8')) > MAX_LINE:
            raise ValueError('hy_protocol_output_too_large')
        sys.stdout.write(encoded + '\n')
        sys.stdout.flush()

    async def host(self, method, params):
        self.sequence += 1
        identity = f'host-{self.sequence}'
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        self.emit({'id': identity, 'method': method, 'params': params})
        try:
            return await future
        finally:
            self.pending.pop(identity, None)

    def read(self, loop):
        try:
            while not self.closed:
                line = sys.stdin.buffer.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    raise ValueError('hy_protocol_input_too_large')
                message = json.loads(line)
                if not isinstance(message, dict) or not isinstance(message.get('id'), (str, int)):
                    raise ValueError('hy_protocol_invalid')
                loop.call_soon_threadsafe(self.receive, message)
        except Exception:
            pass
        finally:
            if not loop.is_closed():
                loop.call_soon_threadsafe(self.disconnected)

    def receive(self, message):
        identity = message['id']
        if 'method' not in message and identity in self.pending:
            future = self.pending[identity]
            if future.done():
                self.disconnected()
            elif 'error' in message:
                error = RuntimeError('hy_host_operation_failed')
                error.code = (message['error'] or {}).get('code', 'hy_host_operation_failed')
                future.set_exception(error)
            else:
                future.set_result(message.get('result'))
        elif 'method' in message:
            self.requests.put_nowait(message)
        else:
            self.disconnected()

    def disconnected(self):
        for future in self.pending.values():
            if not future.done():
                future.set_exception(RuntimeError('hy_host_disconnected'))
        self.requests.put_nowait(None)

    async def run(self):
        reader = threading.Thread(target=self.read, args=(asyncio.get_running_loop(),), daemon=True)
        reader.start()
        try:
            while not self.closed:
                request = await self.requests.get()
                if request is None:
                    break
                identity, method = request['id'], request.get('method')
                try:
                    if method == 'capabilities':
                        result = self.engine.capabilities()
                    elif method == 'close':
                        result = {'closed': True}
                        self.closed = True
                    elif method in ('organize', 'consolidate', 'recall', 'forget'):
                        params = request.get('params')
                        if not isinstance(params, dict):
                            raise ValueError('hy_params_invalid')
                        result = await getattr(self.engine, method)(params)
                    else:
                        raise ValueError('hy_method_unknown')
                    self.emit({'id': identity, 'result': result})
                except Exception as error:
                    code = str(error) if isinstance(error, ValueError) and str(error).startswith('hy_') else getattr(error, 'code', 'hy_worker_failed')
                    self.emit({'id': identity, 'error': {'code': code, 'message': 'The memory operation did not complete. No staged changes were committed.'}})
        finally:
            self.closed = True
            reader.join(timeout=1.0)


if __name__ == '__main__':
    asyncio.run(Worker().run())
