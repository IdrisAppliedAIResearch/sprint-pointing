import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../server/app.ts';
import gateway from '../hosting/legacy-gateway.js';

const gatewayToken = 'test-gateway-key-that-is-not-a-jira-pat-123456';
const jira = { mcpUrl: 'http://127.0.0.1:1/mcp', url: 'https://jira.example.test', boardId: '9001', field: 'customfield_10106' };
const env = { SPRINT_ORIGIN_URL: 'https://meeting.example.test', SPRINT_GATEWAY_TOKEN: gatewayToken };

afterEach(() => vi.unstubAllGlobals());

it('rejects direct origin requests without the gateway key and accepts authenticated requests', async () => {
  const app = await buildApp({ jira, gatewayToken });
  onTestFinished(() => app.close());
  for (const supplied of ['', 'incorrect']) {
    const response = await app.inject({ method: 'POST', url: '/api/rooms', headers: { 'x-sprint-gateway-auth': supplied }, payload: { name: 'Moderator', deck: 'scrum' } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"Not found"}');
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  const response = await app.inject({ method: 'POST', url: '/api/rooms', headers: { 'x-sprint-gateway-auth': gatewayToken, 'x-forwarded-proto': 'https' }, payload: { name: 'Moderator', deck: 'scrum' } });
  expect(response.statusCode).toBe(200);
  expect(response.cookies[0].secure).toBe(true);
  expect(response.body).not.toContain(gatewayToken);
});

it('rejects unauthenticated WebSocket upgrades at the origin', async () => {
  const app = await buildApp({ jira, gatewayToken });
  await app.listen({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => app.close());
  const address = app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/rooms/unknown/live`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => reject(new Error('Unauthenticated socket was accepted')));
    socket.once('unexpected-response', (_request, response) => {
      expect(response.statusCode).toBe(404);
      response.resume();
      socket.terminate();
      resolve();
    });
    socket.on('error', () => {});
  });
});

it('requires a sufficiently long gateway key', async () => {
  await expect(buildApp({ jira, gatewayToken: 'short' })).rejects.toThrow('at least 32');
});

it('forwards only application cookies and never ChatGPT identity or authorization headers', async () => {
  const upstream = vi.fn(async (_request: Request) => new Response('ok'));
  vi.stubGlobal('fetch', upstream);
  const request = new Request('https://site.example.test/api/rooms?view=active', { headers: {
    cookie: 'platform_session=secret; participant=room-cookie; other=private',
    authorization: 'Bearer visitor-secret',
    'oai-sites-authorization': 'Bearer service-secret',
    'oai-authenticated-user-email': 'private@example.test',
    'x-sprint-gateway-auth': 'attacker-value',
  } });
  const response = await gateway.fetch(request, env);
  const forwarded = upstream.mock.calls[0][0] as Request;
  expect(forwarded.url).toBe('https://meeting.example.test/api/rooms?view=active');
  expect(forwarded.headers.get('cookie')).toBe('participant=room-cookie');
  expect(forwarded.headers.get('authorization')).toBeNull();
  expect(forwarded.headers.get('oai-sites-authorization')).toBeNull();
  expect(forwarded.headers.get('oai-authenticated-user-email')).toBeNull();
  expect(forwarded.headers.get('x-sprint-gateway-auth')).toBe(gatewayToken);
  expect(forwarded.headers.get('x-forwarded-proto')).toBe('https');
  expect(forwarded.redirect).toBe('manual');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).not.toContain(gatewayToken);
});

it('streams the runtime PAT to the HTTPS origin without saving it or returning it', async () => {
  const upstream = vi.fn(async (_request: Request) => new Response('{"id":"room"}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', upstream);
  const token = 'temporary-test-pat-never-a-real-credential';
  const response = await gateway.fetch(new Request('https://site.example.test/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://site.example.test' }, body: JSON.stringify({ name: 'Moderator', deck: 'scrum', token }) }), env);
  const forwarded = upstream.mock.calls[0][0] as Request;
  expect(new URL(forwarded.url).protocol).toBe('https:');
  expect(await forwarded.json()).toEqual({ name: 'Moderator', deck: 'scrum', token });
  expect(await response.text()).not.toContain(token);
});

it('rejects cross-origin mutations and WebSocket upgrades', async () => {
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  for (const request of [
    new Request('https://site.example.test/api/rooms', { method: 'POST', headers: { origin: 'https://attacker.example.test' }, body: '{}' }),
    new Request('https://site.example.test/api/rooms/room/live', { headers: { origin: 'https://attacker.example.test', upgrade: 'websocket' } }),
  ]) expect((await gateway.fetch(request, env)).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

it('preserves WebSocket upgrade responses', async () => {
  const response = { status: 101, webSocket: {} };
  const upstream = vi.fn(async (_request: Request) => response);
  vi.stubGlobal('fetch', upstream);
  const request = new Request('https://site.example.test/api/rooms/room/live', { headers: { upgrade: 'websocket', origin: 'https://site.example.test' } });
  expect(await gateway.fetch(request, env)).toBe(response);
  expect((upstream.mock.calls[0][0] as Request).headers.get('upgrade')).toBe('websocket');
});

it('fails closed for missing configuration, insecure origins, and offline backends', async () => {
  const upstream = vi.fn(async () => { throw new Error('Sensitive backend details'); });
  vi.stubGlobal('fetch', upstream);
  const request = () => new Request('https://site.example.test/');
  expect((await gateway.fetch(request(), {})).status).toBe(503);
  for (const origin of ['http://meeting.example.test', 'https://user:secret@meeting.example.test', 'https://meeting.example.test/subpath']) {
    expect((await gateway.fetch(request(), { ...env, SPRINT_ORIGIN_URL: origin })).status).toBe(503);
  }
  expect(upstream).not.toHaveBeenCalled();
  const response = await gateway.fetch(request(), env);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('Sensitive');
});
