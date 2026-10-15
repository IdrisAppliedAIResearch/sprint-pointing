// The token a tab got by joining through the invite link. The moderator's browser uses its cookie instead.
export const tabToken = (room: string) => sessionStorage.getItem(`participant:${room}`);

export async function api<T = void>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const token = tabToken(/^\/api\/rooms\/([\w-]+)\//.exec(path)?.[1] ?? '');
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { 'x-participant': token }) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  if (method !== 'GET' && path.startsWith('/api/rooms/')) window.dispatchEvent(new Event('room-changed'));
  return res.status === 204 ? (undefined as T) : res.json();
}

let configuration: Promise<{ transport: 'poll' | 'websocket'; credentialStorage: 'encrypted' | 'memory' }> | undefined;

export function serverConfig() {
  return configuration ??= fetch('/api/config', { cache: 'no-store' }).then(async (response) => {
    if (response.status === 404) return { transport: 'websocket' as const, credentialStorage: 'memory' as const };
    if (!response.ok) throw new Error('The server is unavailable');
    return response.json();
  }).catch((error) => {
    configuration = undefined;
    throw error;
  });
}
