import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import worker from '../hosting/site/worker/app.ts';
import { decryptToken, encryptToken, randomToken } from '../hosting/site/worker/credentials.ts';
import { IDLE_MS } from '../hosting/site/worker/store.ts';
import type { Environment, Room } from '../hosting/site/worker/types.ts';
import type { RoomView } from '../shared/protocol.ts';
import { fakeJiraRest } from './fake-jira.ts';
import { testDatabase, testEnvironment } from './cloud-support.ts';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const db = testDatabase();
  onTestFinished(db.close);
  const env = testEnvironment(db.binding);
  env.SPRINT_SESSION_KEY = randomToken();
  const upstream = vi.fn(async (input: string | Request, options?: RequestInit) => fakeJiraRest(input instanceof Request ? input : new Request(input, options)));
  vi.stubGlobal('fetch', upstream);
  const request = (path: string, method = 'GET', data?: unknown, cookie = '', environment: Environment = env, token = '') => worker.fetch(new Request(`https://site.example.test${path}`, {
    method, headers: { cookie, origin: 'https://site.example.test', ...(token ? { 'x-participant': token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data),
  }), environment);
  async function person(roomId: string, cookie: string, token = '') {
    const client = randomToken(16);
    return {
      id: roomId,
      cookie,
      token,
      request: (path = '', method = 'GET', data?: unknown) => request(`/api/rooms/${roomId}${path}`, method, data, cookie, env, token),
      live: async () => {
        const response = await request(`/api/rooms/${roomId}/live?client=${client}`, 'GET', undefined, cookie, env, token);
        expect(response.status).toBe(200);
        return response.json() as Promise<RoomView>;
      },
      leave: () => request(`/api/rooms/${roomId}/leave`, 'POST', { clientId: client }, cookie, env, token),
    };
  }
  async function create(token?: string) {
    const response = await request('/api/rooms', 'POST', { name: 'Ann', deck: 'scrum', ...(token === undefined ? {} : { token }) });
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    return person(id, response.headers.get('set-cookie')!.split(';')[0]);
  }
  async function join(id: string, name = 'Bob') {
    const response = await request(`/api/rooms/${id}/join`, 'POST', { name });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const { token } = await response.json() as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return person(id, '', token);
  }
  return { db, env, request, create, join, upstream };
}

it('hosts the frontend, configuration, and database without any local origin', async () => {
  const { request, upstream } = setup();
  expect((await request('/api/config').then((response) => response.json()))).toMatchObject({ transport: 'poll', backend: 'sites' });
  expect((await request('/api/health').then((response) => response.json()))).toMatchObject({ storage: 'd1', localDependencies: false });
  expect((await request('/')).status).toBe(200);
  expect((await request('/assets/missing.js')).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});

it('encrypts each PAT with authenticated per-room encryption and stores only cookie hashes', async () => {
  const { create, db, env, request } = setup();
  const token = 'temporary-offline-test-token';
  const ann = await create(token);
  const row = db.sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(ann.id) as { body: string; credential: string };
  expect(JSON.stringify(row)).not.toContain(token);
  expect(JSON.stringify(row)).not.toContain(ann.cookie.split('=')[1]);
  expect(await decryptToken(row.credential, ann.id, env.SPRINT_SESSION_KEY)).toBe(token);
  await expect(decryptToken(row.credential, 'another-room', env.SPRINT_SESSION_KEY)).rejects.toThrow('new meeting');
  await expect(decryptToken(row.credential, ann.id, randomToken())).rejects.toThrow('new meeting');
  expect(await encryptToken(token, ann.id, env.SPRINT_SESSION_KEY)).not.toBe(row.credential);
  const snapshot = JSON.stringify(await ann.live());
  expect(snapshot).not.toContain(token);
  expect(snapshot).not.toContain('tokenHash');
  expect(snapshot).not.toContain('credential');
  const rejected = await request('/api/rooms', 'POST', { name: 'Ann', deck: 'scrum', token: 'bad-token' });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).not.toContain('bad-token');
});

it('fails closed without encryption and never forwards visitor credentials to Jira', async () => {
  const { request, env, upstream } = setup();
  const unavailable = await request('/api/rooms', 'POST', { name: 'Ann', deck: 'scrum', token: 'offline-token' }, '', { ...env, SPRINT_SESSION_KEY: '' });
  expect(unavailable.status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
  const response = await worker.fetch(new Request('https://site.example.test/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer platform-secret', cookie: 'platform=secret', 'oai-sites-authorization': 'Bearer service-secret', 'oai-authenticated-user-email': 'user@example.test' }, body: JSON.stringify({ name: 'Ann', deck: 'scrum', token: 'offline-token' }) }), env);
  expect(response.status).toBe(200);
  for (const [input, options] of upstream.mock.calls) {
    const sent = input instanceof Request ? input : new Request(input, options);
    expect(sent.headers.get('authorization')).toBe('Bearer offline-token');
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('oai-sites-authorization')).toBeNull();
    expect(sent.headers.get('oai-authenticated-user-email')).toBeNull();
    expect(sent.redirect).toBe('manual');
  }
});

it('persists shared meetings across fresh request environments and hides other votes until reveal', async () => {
  const { create, join, request, env } = setup();
  const ann = await create();
  const bob = await join(ann.id);
  await Promise.all([ann.live(), bob.live()]);
  expect((await ann.request('/stories', 'POST', { tickets: ['Login'] })).status).toBe(204);
  expect((await ann.request('/start', 'POST', {})).status).toBe(204);
  expect((await ann.request('/vote', 'POST', { value: '3' })).status).toBe(204);
  expect((await bob.live()).players.find((person) => person.name === 'Ann')).toMatchObject({ voted: true, vote: null });
  expect((await ann.live()).players.find((person) => person.name === 'Ann')?.vote).toBe('3');
  expect((await bob.request('/vote', 'POST', { value: '5' })).status).toBe(204);
  const persisted = await request(`/api/rooms/${ann.id}/live?client=${randomToken(16)}`, 'GET', undefined, ann.cookie, { ...env });
  expect(await persisted.json()).toMatchObject({ round: 'revealed', players: [{ vote: '3' }, { vote: '5' }] });
  const finished = await ann.request('/finish', 'POST', { points: 5 });
  expect(await finished.json()).toMatchObject({ revision: { status: 'synced', to: 5 } });
  expect((await ann.live()).stories[0].points).toBe(5);
});

it('enforces participant and moderator permissions, observer rules, and room-scoped cookies', async () => {
  const { create, join, request, env } = setup();
  const ann = await create();
  const bob = await join(ann.id);
  await ann.live();
  await bob.live();
  expect((await request(`/api/rooms/${ann.id}/live?client=${randomToken(16)}`)).status).toBe(401);
  expect((await bob.request('/stories', 'POST', { tickets: ['Unauthorized'] })).status).toBe(403);
  expect((await bob.request('', 'DELETE')).status).toBe(403);
  const other = await create();
  expect((await request(`/api/rooms/${other.id}/live?client=${randomToken(16)}`, 'GET', undefined, bob.cookie, env, bob.token)).status).toBe(401);
  await ann.request('/stories', 'POST', { tickets: ['Login'] });
  await ann.request('/start', 'POST', {});
  await bob.request('/observer', 'POST', { observer: true });
  expect((await bob.request('/vote', 'POST', { value: '5' })).status).toBe(403);
  await ann.request('/vote', 'POST', { value: '3' });
  expect((await ann.live()).round).toBe('revealed');
});

it('keeps an invited tab separate from its moderator cookie and rejects invalid tab credentials', async () => {
  const { create, join, request, env } = setup();
  const ann = await create();
  const bob = await join(ann.id);
  const moderator = await ann.live();
  const path = `/api/rooms/${ann.id}`;
  const response = await request(`${path}/live?client=${randomToken(16)}`, 'GET', undefined, ann.cookie, env, bob.token);
  expect(response.status).toBe(200);
  const participant = await response.json() as RoomView;
  expect(participant.me).not.toBe(moderator.me);
  expect(participant.players.find((person) => person.id === participant.me)?.name).toBe('Bob');
  expect((await request(`${path}/stories`, 'POST', { tickets: ['Not authorized'] }, ann.cookie, env, bob.token)).status).toBe(403);
  expect((await request(`${path}/live?client=${randomToken(16)}`, 'GET', undefined, ann.cookie, env, randomToken())).status).toBe(401);
  expect((await ann.live()).me).toBe(moderator.me);
});

it('serializes concurrent room changes without losing votes or stories', async () => {
  const { create } = setup();
  const ann = await create();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => ann.request('/stories', 'POST', { tickets: [`Story ${index}`] })));
  expect(responses.every((response) => response.status === 204)).toBe(true);
  const view = await ann.live();
  expect(view.stories).toHaveLength(8);
  expect(new Set(view.stories.map((ticket) => ticket.id)).size).toBe(8);
});

it('uses direct Jira REST pagination, project scoping, verified writes, and unchanged wiki descriptions', async () => {
  const { create, upstream } = setup();
  const ann = await create('offline-token');
  expect(await ann.request('/sprints').then((response) => response.json())).toHaveLength(3);
  expect(await ann.request('/sprints/7001/issues').then((response) => response.json())).toHaveLength(54);
  expect((await ann.request('/stories', 'POST', { tickets: ['OTHER-1'] })).status).toBe(400);
  await ann.request('/stories', 'POST', { tickets: ['FAKE-48', 'FAKE-13', 'FAKE-14', 'FAKE-1'] });
  const stories = (await ann.live()).stories;
  const points = await ann.request(`/stories/${stories[0].id}/points`, 'POST', { points: 8 });
  expect(await points.json()).toMatchObject({ revision: { status: 'synced', to: 8 } });
  for (const ticket of stories.slice(1, 3)) {
    const failed = await ann.request(`/stories/${ticket.id}/points`, 'POST', { points: 13 });
    expect(await failed.json()).toMatchObject({ revision: { status: 'failed', to: 13 } });
  }
  const wiki = '*As a* user,\r\n*I want* cloud hosting.\r\n** Keep wiki markup';
  expect((await ann.request(`/stories/${stories[3].id}`, 'PATCH', { description: wiki })).status).toBe(204);
  await ann.request('/sync', 'POST', {});
  expect((await ann.live()).stories[3].description).toBe(wiki);
  expect(upstream.mock.calls.every(([input]) => String(input).startsWith('https://jira.example.test/rest/'))).toBe(true);
});

it('recovers interrupted pending writes instead of leaving estimates pending forever', async () => {
  const { create, db } = setup();
  const ann = await create();
  await ann.request('/stories', 'POST', { tickets: ['Login'] });
  const row = db.sqlite.prepare('SELECT body FROM rooms WHERE id = ?').get(ann.id) as { body: string };
  const room = JSON.parse(row.body) as Room;
  room.stories[0].revisions.push({ id: 1, from: null, to: 3, by: 'Ann', at: Date.now(), status: 'pending', error: null });
  db.sqlite.prepare('UPDATE rooms SET body = ? WHERE id = ?').run(JSON.stringify(room), ann.id);
  await ann.request('/observer', 'POST', { observer: true });
  expect((await ann.live()).stories[0].revisions[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
});

it('removes credentials when meetings end, rejects expired meetings, and purges expired rows', async () => {
  const { create, db } = setup();
  const ended = await create('offline-token');
  await ended.live();
  expect((await ended.request('', 'DELETE')).status).toBe(204);
  expect(db.sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(ended.id)).toBeUndefined();
  expect(db.sqlite.prepare('SELECT * FROM presence WHERE room_id = ?').get(ended.id)).toBeUndefined();
  const expired = await create('offline-token');
  db.sqlite.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - IDLE_MS, expired.id);
  expect((await expired.request(`/live?client=${randomToken(16)}`)).status).toBe(404);
  expect(db.sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(expired.id)).toBeUndefined();
});

it('rejects cross-origin requests, oversized bodies, and insecure Jira configuration', async () => {
  const { env, request, upstream } = setup();
  const forged = await worker.fetch(new Request('https://site.example.test/api/rooms', { method: 'POST', headers: { origin: 'https://attacker.example.test' }, body: '{}' }), env);
  expect(forged.status).toBe(403);
  const oversized = await request('/api/rooms', 'POST', { name: 'Ann', deck: 'scrum', token: 'x'.repeat(70_000) });
  expect(oversized.status).toBe(413);
  const insecure = await request('/api/rooms', 'POST', { name: 'Ann', deck: 'scrum', token: 'offline-token' }, '', { ...env, JIRA_URL: 'http://jira.example.test' });
  expect(insecure.status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});
