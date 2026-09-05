const MAX_RANGE_BYTES = 256 * 1024;

export function createResourceHandler({ core, surfacePolicy }) {
  return async function handleResource(request) {
    try {
      if (Number.isSafeInteger(request.webContentsId)
        && request.webContentsId >= 0
        && !surfacePolicy.acceptsWebContentsId(request.webContentsId)) {
        return new Response('denied', { status: 403 });
      }
      const url = new URL(request.url);
      if (url.protocol !== 'superwagie-resource:' || url.hostname !== 'content') {
        return new Response('not found', { status: 404 });
      }
      const handleId = decodeURIComponent(url.pathname.slice(1));
      const offset = Number(url.searchParams.get('offset'));
      const length = Number(url.searchParams.get('length'));
      if (!handleId || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length < 1 || length > MAX_RANGE_BYTES) {
        return new Response('invalid range', { status: 400 });
      }
      const result = await core.request({
        type: 'resource_read', handle_id: handleId, audience: 'app_ui', offset, length,
      });
      return new Response(Buffer.from(result.content_hex, 'hex'), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': 'superwagie-app://surface',
        },
      });
    } catch {
      return new Response('resource unavailable', { status: 410 });
    }
  };
}
