/** No imports in the generated plugin. OpenCode loads it from its private directory. */
export const createPluginSource = (bootstrap = '') => `
export default {
  id: 'superwagie-unihub-model',
  setup: async (ctx) => {
    const flows = new Map();
    const base = process.env.OPENCHAMBER_UNIHUB_PROXY_URL;
    const bootstrap = ${JSON.stringify(bootstrap)};
    const encoder = new TextEncoder();
    const b64 = (bytes) => { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, ''); };
    const random = () => b64(crypto.getRandomValues(new Uint8Array(24)));
    const digest = async (body) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))));
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const signingKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sessionNonce = random();
    let ipcSession = '';
    const handshake = new Promise((resolve, reject) => {
      if (typeof process?.send !== 'function') { reject(Error('platform_ipc_unavailable')); return; }
      const timeout = setTimeout(() => reject(Error('platform_ipc_timeout')), 10000);
      const onMessage = (message) => {
        if (message?.type !== 'unihub-platform-handshake-ack' || message.nonce !== sessionNonce || !message.sessionID) return;
        clearTimeout(timeout); ipcSession = message.sessionID; resolve();
      };
      process.on('message', onMessage);
      process.send({ type: 'unihub-platform-handshake', bootstrap, nonce: sessionNonce, secret: b64(secretBytes) }, (error) => { if (error) reject(error); });
    });
    const signedHeaders = async (method, pathname, body, headers = {}) => {
      await handshake;
      const requestNonce = random();
      const signatureInput = sessionNonce + '\\n' + requestNonce + '\\n' + method.toUpperCase() + '\\n' + pathname + '\\n' + await digest(body);
      const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, encoder.encode(signatureInput))));
      return { ...headers, 'x-unihub-ipc-session': ipcSession, 'x-unihub-ipc-nonce': requestNonce, 'x-unihub-ipc-signature': signature };
    };
    const call = async (pathname, options = {}) => {
      const body = options.body === undefined ? '' : String(options.body);
      const headers = await signedHeaders(options.method || 'POST', pathname, body, options.headers || {});
      return fetch(base + pathname, { ...options, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
    };
    const keyOf = (e) => e.sessionID + ':' + e.agent + ':' + e.model.id + ':' + (e.model.variant || 'default');
    const platform = (e) => e.model.providerID === 'unihub';
    await ctx.session.hook('model.request', async (e) => {
      if (!platform(e)) return;
      if (!base || e.kind !== 'primary') throw Error('platform_protocol_unsupported');
      const key = keyOf(e);
      // The durable proxy admits a fresh generation only after the old receipt is terminal.
      // This also permits an explicit reconciliation after a plugin reload or interrupted stream.
      const id = crypto.randomUUID();
      const response = await call('/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionID: e.sessionID, callID: id, model: e.model.id, kind: e.kind }) });
      if (!response.ok) throw Error('platform_call_not_authorized');
      const binding = await response.json();
      if (binding.callID !== id || binding.baseURL !== base + '/v1') throw Error('platform_binding_invalid');
      flows.set(key, { id, phase: 'prepared' });
      e.baseURL = base + '/v1';
      e.headers['x-unihub-session-id'] = e.sessionID;
      e.headers['idempotency-key'] = id;
    });
    await ctx.session.hook('http.request', async (e) => {
      if (!platform(e)) return;
      const flow = flows.get(keyOf(e));
      if (e.kind !== 'primary' || !flow || flow.phase !== 'prepared' || e.request.url !== base + '/v1/chat/completions' || e.request.headers.get('idempotency-key') !== flow.id) throw Error('platform_request_unbound');
      const body = await e.request.clone().text();
      const headers = await signedHeaders('POST', '/v1/chat/completions', body, Object.fromEntries(e.request.headers.entries()));
      delete headers.authorization;
      e.request = new Request(e.request, { headers });
      flow.phase = 'submitted';
    });
    await ctx.session.hook('http.response', async (e) => {
      if (!platform(e)) return;
      const flow = flows.get(keyOf(e));
      if (!flow || flow.id !== e.request.headers.get('idempotency-key')) throw Error('platform_response_unbound');
      const response = e.response;
      if (!response.ok || !response.body) { flow.phase = 'unknown'; return; }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let done = false;
      e.response = new Response(new ReadableStream({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { flow.phase = done && !pending.trim() ? 'complete' : 'unknown'; controller.close(); return; }
            pending += decoder.decode(item.value, { stream: true });
            if (pending.length > 1048576) throw Error('platform_stream_invalid');
            let end;
            while ((end = pending.indexOf('\\n')) >= 0) { const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); if (line === 'data: [DONE]') done = true; }
            controller.enqueue(item.value);
          } catch (error) { if (flow.phase !== 'complete') flow.phase = 'unknown'; controller.error(error); }
        },
        async cancel(reason) { if (flow.phase !== 'complete') flow.phase = 'unknown'; await reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    });
    await ctx.session.hook('retry', async (e) => {
      if (!platform(e)) return;
      // Gateway retries retain their durable call. A client retry cannot establish no execution.
      e.decision = { retry: false };
      const flow = flows.get(keyOf(e)); if (flow && flow.phase !== 'complete') flow.phase = 'unknown';
    });
  },
};
`;
