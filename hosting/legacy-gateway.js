const forwardedHeaders = [
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'range',
  'if-range',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
];

function unavailable() {
  return new Response('The meeting server is offline. Ask the moderator to start the local hosting session.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    if (!env.SPRINT_ORIGIN_URL || !env.SPRINT_GATEWAY_TOKEN) return unavailable();
    let origin;
    try {
      origin = new URL(env.SPRINT_ORIGIN_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable();
    } catch {
      return unavailable();
    }

    const incoming = new URL(request.url);
    const browserOrigin = request.headers.get('origin');
    const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (browserOrigin && browserOrigin !== incoming.origin && (websocket || !['GET', 'HEAD', 'OPTIONS'].includes(request.method))) {
      return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
    }

    const target = new URL(origin);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers();
    for (const name of forwardedHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const participantCookies = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('participant='));
    if (participantCookies.length) headers.set('cookie', participantCookies.join('; '));
    if (browserOrigin) headers.set('origin', browserOrigin);
    headers.set('x-sprint-gateway-auth', env.SPRINT_GATEWAY_TOKEN);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', incoming.host);

    try {
      const response = await fetch(new Request(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
        duplex: 'half',
      }));
      if (response.status === 101) return response;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('cache-control', 'no-store');
      responseHeaders.set('referrer-policy', 'no-referrer');
      responseHeaders.set('x-content-type-options', 'nosniff');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch {
      return unavailable();
    }
  },
};
