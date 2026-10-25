/** No imports in the generated plugin. OpenCode loads it from its private directory. */
export const createPluginSource = () => `
export default {
  id: 'superwagie-unihub-model',
  setup: async (ctx) => {
    const flows = new Map();
    const base = process.env.OPENCHAMBER_UNIHUB_PROXY_URL;
    const token = process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
    const keyOf = (e) => e.sessionID + ':' + e.agent + ':' + e.model.id + ':' + (e.model.variant || 'default');
    const platform = (e) => e.model.providerID === 'unihub';
    await ctx.session.hook('model.request', async (e) => {
      if (!platform(e)) return;
      if (!base || !token || e.kind !== 'primary') throw Error('platform_protocol_unsupported');
      const key = keyOf(e);
      // The durable proxy admits a fresh generation only after the old receipt is terminal.
      // This also permits an explicit reconciliation after a plugin reload or interrupted stream.
      const id = crypto.randomUUID();
      const response = await fetch(base + '/prepare', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionID: e.sessionID, callID: id, model: e.model.id, kind: e.kind }),
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error('platform_call_not_authorized');
      const binding = await response.json();
      if (binding.callID !== id || binding.baseURL !== base + '/v1') throw Error('platform_binding_invalid');
      flows.set(key, { id, phase: 'prepared' });
      e.baseURL = base + '/v1';
      e.headers.authorization = 'Bearer ' + token;
      e.headers['x-unihub-session-id'] = e.sessionID;
      e.headers['idempotency-key'] = id;
    });
    await ctx.session.hook('http.request', async (e) => {
      if (!platform(e)) return;
      const flow = flows.get(keyOf(e));
      if (e.kind !== 'primary' || !flow || flow.phase !== 'prepared' || e.request.url !== base + '/v1/chat/completions' || e.request.headers.get('idempotency-key') !== flow.id) throw Error('platform_request_unbound');
      const headers = new Headers(e.request.headers);
      headers.set('authorization', 'Bearer ' + token);
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
