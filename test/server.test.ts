import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../server/app.ts';
import { DECKS, type Issue, type RoomView } from '../shared/protocol.ts';
import { holdWrites, startFakeJira } from './fake-jira.ts';

const PAT = 'pat-0123456789-must-never-leak';

let fake: Awaited<ReturnType<typeof startFakeJira>>;
beforeAll(async () => {
  fake = await startFakeJira();
});
afterAll(() => fake.close());

// Every response and snapshot a test receives; none may carry the PAT.
const seen: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  expect(seen.splice(0).filter((text) => text.includes(PAT))).toEqual([]);
});

// Each Jira session has one MCP client; this counts them being closed.
const jiraCloses = () => vi.spyOn(Client.prototype, 'close');

// Holds every Jira write until the test releases it, or ends.
function holdJira() {
  const release = holdWrites();
  onTestFinished(() => release());
  return release;
}

async function start(mcpUrl = fake.url) {
  const app = await buildApp({ jira: { mcpUrl, url: 'https://jira.example.test', boardId: '9001', field: 'customfield_10106' } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => app.close());
  return app;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
// Who is calling: the moderator's browser sends its cookie, a tab that joined by link sends its token.
type Auth = { cookie?: string; 'x-participant'?: string };

async function request(app: FastifyInstance, method: Method, url: string, payload?: object, auth: Auth = {}) {
  const res = await app.inject({ method, url, payload, headers: auth });
  seen.push(JSON.stringify(res.headers), res.body);
  return res;
}

// Someone in a session, calling that session's routes.
function participant(app: FastifyInstance, id: string, auth: Auth) {
  const send = async (method: Method, path: string, payload?: object) => {
    const res = await request(app, method, `/api/rooms/${id}${path}`, payload, auth);
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const ok = async (method: Method, path: string, payload?: object) => {
    const { status, body } = await send(method, path, payload);
    if (status >= 300) throw new Error(`${method} ${path} → ${status} ${JSON.stringify(body)}`);
    return body;
  };
  return {
    id,
    auth,
    get: (path: string) => ok('GET', path),
    post: (path: string, body?: object) => ok('POST', path, body),
    patch: (path: string, body: object) => ok('PATCH', path, body),
    del: (path = '') => ok('DELETE', path),
    fail: async (method: Method, path: string, body?: object) => {
      const { status, body: res } = await send(method, path, body);
      return { status, error: res?.error };
    },
    live: () => live(app, id, auth),
  };
}
type Participant = ReturnType<typeof participant>;

// Creating and joining a session set its participant cookie.
async function enter(app: FastifyInstance, url: string, body: object) {
  const res = await request(app, 'POST', url, body);
  const cookie = res.cookies.find((c) => c.name === 'participant');
  if (!cookie) throw new Error(`POST ${url} → ${res.statusCode} ${res.body}`);
  return { res, cookie };
}

async function create(app: FastifyInstance, body: { name: string; [field: string]: unknown }) {
  const { res, cookie } = await enter(app, '/api/rooms', { deck: 'scrum', ...body });
  return participant(app, res.json().id, { cookie: `participant=${cookie.value}` });
}

async function join(app: FastifyInstance, id: string, name: string) {
  return participant(app, id, { 'x-participant': (await request(app, 'POST', `/api/rooms/${id}/join`, { name })).json().token });
}

// A browser's WebSocket can't send headers: a joined tab offers its token as the second protocol.
const socket = (app: FastifyInstance, id: string, { cookie, 'x-participant': token }: Auth, autoPong = true) =>
  new WebSocket(wsUrl(app, id), token ? ['participant', token] : [], { headers: cookie ? { cookie } : {}, autoPong });

const wsUrl = (app: FastifyInstance, id: string) =>
  `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/rooms/${id}/live`;

// Resolves on the first snapshot, i.e. once the server counts this socket as present.
async function live(app: FastifyInstance, id: string, auth: Auth, autoPong = true) {
  const ws = socket(app, id, auth, autoPong);
  const closed = new Promise<number>((resolve) => ws.on('close', resolve));
  let room: RoomView | undefined;
  let check = () => {};
  ws.on('message', (data) => {
    seen.push(String(data));
    room = JSON.parse(String(data));
    check();
  });
  // The latest snapshot that passes `test`, waiting for the next ones if needed.
  const until = (test: (room: RoomView) => boolean) =>
    new Promise<RoomView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No matching snapshot; last: ${JSON.stringify(room)}`)), 2000);
      check = () => {
        if (room && test(room)) {
          clearTimeout(timer);
          resolve(room);
        }
      };
      check();
    });
  await until(() => true);
  return { get room() { return room!; }, until, closed, close: () => ws.close() };
}

const closeCode = (app: FastifyInstance, id: string, auth: Auth) =>
  new Promise<number>((resolve) => socket(app, id, auth).on('close', resolve));

const player = (room: RoomView, name: string) => room.players.find((p) => p.name === name);
const story = (room: RoomView, key: string) => room.stories.find((s) => s.key === key)!;
const FAKE1_DESCRIPTION = '*As a* stakeholder,\r\n*I want* a short sprint summary.\r\n\r\nAcceptance Criteria\r\n* Fits one screen\r\n** no tables'; // Jira's wiki markup, with Jira's line breaks

// What the fake Jira holds now, read back through the session.
async function jiraPoints(moderator: Participant, key: string) {
  const issues: Issue[] = await moderator.get('/sprints/7001/issues');
  return issues.find((i) => i.key === key)?.points;
}

it('starts a Jira session with a PAT Jira accepts and a custom session without one, the starter as moderator', async () => {
  const app = await start();
  const { res, cookie } = await enter(app, '/api/rooms', { name: ' Ann ', deck: 'fibonacci', token: PAT });
  const { id } = res.json();
  expect(id).toMatch(/^[\w-]{16}$/); // 12 random bytes
  expect(cookie).toMatchObject({ path: `/api/rooms/${id}`, httpOnly: true, sameSite: 'Lax', maxAge: 86400 });
  expect(cookie.value).toMatch(/^[\w-]{43}$/); // 32 random bytes
  const { room } = await participant(app, id, { cookie: `participant=${cookie.value}` }).live();
  expect(room).toEqual({
    id, mode: 'jira', cards: DECKS.fibonacci.cards, ownerId: room.me, me: expect.any(Number), now: expect.any(Number),
    round: 'idle', storyId: null, timerStart: null, timerStop: null, stories: [],
    players: [{ id: room.me, name: 'Ann', online: true, observer: false, voted: false, vote: null, votedAt: null }],
  });

  const custom = await create(app, { name: 'Bob' });
  expect((await custom.live()).room).toMatchObject({ mode: 'custom', cards: DECKS.scrum.cards }); // no range: the whole deck
  const proxied = await app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'Cy', deck: 'scrum' }, headers: { 'x-forwarded-proto': 'https' } });
  expect(proxied.cookies).toMatchObject([{ name: 'participant', secure: true }]); // behind a TLS proxy

  const closes = jiraCloses();
  const rejected = await request(app, 'POST', '/api/rooms', { name: 'Ann', deck: 'scrum', token: ' bad-token\n' }); // pasted
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json()).toEqual({ error: 'Jira rejected the token: Invalid user Jira token or configuration: Unable to get current user account ID:' });
  expect(rejected.cookies).toEqual([]);
  expect(closes).toHaveBeenCalledOnce(); // its Jira connection
  for (const invalid of [
    { name: ' ', deck: 'scrum' },
    { name: 'A'.repeat(51), deck: 'scrum' },
    { name: 'Ann', deck: 'tshirt' },
    { name: 'Ann', deck: 'scrum', token: 'x'.repeat(501) },
    { name: 'Ann', deck: 'scrum', token: `${PAT}\u0000` }, // not a valid header value: the HTTP client's error would quote it
  ]) expect((await request(app, 'POST', '/api/rooms', invalid)).statusCode, JSON.stringify(invalid)).toBe(400);
});

it('says the Jira MCP server is down instead of blaming the token', async () => {
  const app = await start('http://127.0.0.1:9/mcp');
  const res = await request(app, 'POST', '/api/rooms', { name: 'Ann', deck: 'scrum', token: PAT });
  expect([res.statusCode, res.json()]).toEqual([502, { error: "Can't reach the Jira MCP server. Is it running (docker compose up -d)?" }]);
});

it('joins a session by its link with just a name, each tab its own player, even in the moderator browser', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  const annWs = await ann.live();
  const res = await request(app, 'POST', `/api/rooms/${ann.id}/join`, { name: ' Bob ' });
  expect(res.cookies).toEqual([]); // the moderator's cookie in this browser stays the moderator's
  const { token } = res.json();
  expect(token).toMatch(/^[\w-]{43}$/);
  // A second tab in Ann's browser: it still sends her cookie, and its own token wins.
  const bob = participant(app, ann.id, { ...ann.auth, 'x-participant': token });
  const { room } = await bob.live();
  expect(room.players.map((p) => [p.name, p.online])).toEqual([['Ann', true], ['Bob', true]]);
  expect(room.ownerId).toBe(annWs.room.me);
  expect(room.me).toBe(player(room, 'Bob')?.id);
  expect(await bob.fail('POST', '/start', {})).toEqual({ status: 403, error: 'Only the moderator can do that' });

  expect((await request(app, 'POST', `/api/rooms/${ann.id}/join`, { name: '' })).statusCode).toBe(400);
  expect((await request(app, 'POST', '/api/rooms/no-such-session/join', { name: 'Cy' })).json()).toEqual({ error: 'Session not found' });

  const other = await create(app, { name: 'Cy' });
  expect(await participant(app, other.id, { 'x-participant': token }).fail('POST', '/observer', { observer: true }))
    .toEqual({ status: 401, error: 'Join the session first' });
  expect(await closeCode(app, other.id, { 'x-participant': token })).toBe(4401);
});

it('lets only the moderator run the session and only participants act in it', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-7'] });
  const storyId = (await ann.live()).room.stories[0].id;
  const bob = await join(app, ann.id, 'Bob');

  const moderatorOnly: [Method, string, object?][] = [
    ['DELETE', ''],
    ['GET', '/sprints'],
    ['GET', '/sprints/7001/issues'],
    ['POST', '/stories', { tickets: ['FAKE-8'] }],
    ['DELETE', `/stories/${storyId}`],
    ['POST', '/sync'],
    ['POST', '/start', {}],
    ['POST', '/next'],
    ['POST', '/reveal'],
    ['POST', '/clear'],
    ['POST', '/timer'],
    ['POST', '/finish', { points: 3 }],
    ['POST', `/stories/${storyId}/points`, { points: 3 }],
  ];
  for (const [method, path, body] of moderatorOnly)
    expect(await bob.fail(method, path, body), `${method} ${path}`).toEqual({ status: 403, error: 'Only the moderator can do that' });

  const stranger = participant(app, ann.id, {});
  const routes: [Method, string, object?][] = [...moderatorOnly, ['POST', '/vote', { value: '5' }], ['POST', '/observer', { observer: true }]];
  for (const [method, path, body] of routes)
    expect(await stranger.fail(method, path, body), `${method} ${path}`).toEqual({ status: 401, error: 'Join the session first' });
  expect(await participant(app, 'no-such-session', ann.auth).fail('POST', '/vote', { value: '5' }))
    .toEqual({ status: 404, error: 'Session not found' });
});

it('browses the board: active then future sprints, and sprint issues in rank order without sub-tasks', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  expect(await ann.get('/sprints')).toEqual([
    { id: '7001', name: 'FAKE Team A Sprint 12', state: 'active' },
    { id: '7002', name: 'FAKE Team B Sprint 12', state: 'active' },
    { id: '7003', name: 'FAKE Team A Sprint 13', state: 'future' },
  ]);

  const issues: Issue[] = await ann.get('/sprints/7001/issues');
  const keys = issues.map((i) => i.key);
  expect(keys).toHaveLength(54); // 55 minus the sub-task FAKE-20, read from Jira as 50 + 4
  expect(new Set(keys).size).toBe(54);
  expect(keys).not.toContain('FAKE-20');
  // The fake ranks FAKE-n at 37n mod 83, so rank order differs from key order; FAKE-47 ranks last (second page).
  expect(keys.slice(0, 4)).toEqual(['FAKE-9', 'FAKE-18', 'FAKE-27', 'FAKE-36']);
  expect(keys.at(-1)).toBe('FAKE-47');

  const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));
  expect(byKey['FAKE-1']).toEqual({ key: 'FAKE-1', summary: 'Summarize the sprint for stakeholders', description: FAKE1_DESCRIPTION, type: 'Story', status: 'Done', assignee: 'Tester, Alice', points: 3 });
  expect(byKey['FAKE-9'].summary).toBe('Update password rotation'); // Jira has a trailing space
  expect(byKey['FAKE-5'].assignee).toBeNull(); // Jira says "Unassigned"
  expect([byKey['FAKE-14'].points, byKey['FAKE-48'].points]).toEqual([0, null]);
  expect(await ann.fail('GET', '/sprints/7001%20OR%201=1/issues')).toEqual({ status: 400, error: 'Invalid sprint id' }); // goes into JQL
});

it('adds Jira tickets in the given order, skipping ones already in the session or missing from Jira, and deletes stories', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-1', 'FAKE-6'] });
  await ann.post('/stories', { tickets: ['FAKE-6', 'FAKE-5', 'FAKE-999'] });
  expect(await ann.fail('POST', '/stories', { tickets: ['FAKE-999'] }))
    .toEqual({ status: 502, error: "An issue with key 'FAKE-999' does not exist for field 'key'." });
  expect(await ann.fail('POST', '/stories', { tickets: ['Login page'] })).toEqual({ status: 400, error: 'Invalid issue key' });
  const ws = await ann.live();
  expect(ws.room.stories.map((s) => s.key)).toEqual(['FAKE-1', 'FAKE-6', 'FAKE-5']);
  expect(ws.room.stories[0]).toEqual({
    id: expect.any(Number), key: 'FAKE-1', summary: 'Summarize the sprint for stakeholders', description: FAKE1_DESCRIPTION, type: 'Story', status: 'Done',
    url: 'https://jira.example.test/browse/FAKE-1', jiraPoints: 3, points: null, revisions: [],
  });

  const fake6 = ws.room.stories[1];
  await ann.post('/start', { storyId: fake6.id });
  await ann.del(`/stories/${fake6.id}`); // the current story
  expect(await ws.until((r) => r.stories.length === 2)).toMatchObject({ round: 'idle', storyId: null, timerStart: null });
  expect(await ann.fail('DELETE', `/stories/${fake6.id}`)).toEqual({ status: 404, error: 'Story not found' });
  expect(await ann.fail('POST', `/stories/${fake6.id}/points`, { points: 1 })).toEqual({ status: 404, error: 'Story not found' });
});

it('looks up more than 50 tickets in chunks, keeping the given order', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  const keys = Array.from({ length: 60 }, (_, i) => `FAKE-${i + 23}`); // Jira answers in key-descending order
  await ann.post('/stories', { tickets: keys });
  expect((await ann.live()).room.stories.map((s) => s.key)).toEqual(keys);
});

it('plays a round with two players: hidden votes, auto-flip, finish writes Jira, next story', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-3', 'FAKE-4'] });
  const bob = await join(app, ann.id, 'Bob');
  const annWs = await ann.live();
  const bobWs = await bob.live();
  const [fake3, fake4] = annWs.room.stories;

  await ann.post('/start', {});
  expect(await bobWs.until((r) => r.round === 'voting'))
    .toMatchObject({ storyId: fake3.id, ownerId: annWs.room.me, timerStart: expect.any(Number), timerStop: null });

  await bob.post('/vote', { value: '3' });
  await bob.post('/vote', { value: '5' }); // a vote can change until the flip
  const annSees = await annWs.until((r) => !!player(r, 'Bob')?.voted);
  expect(player(annSees, 'Bob')).toMatchObject({ vote: null, votedAt: expect.any(Number) });
  expect(annSees.round).toBe('voting');
  await bobWs.until((r) => player(r, 'Bob')?.vote === '5');

  await ann.post('/vote', { value: '8' }); // everyone online has voted: the cards flip
  const revealed = await bobWs.until((r) => r.round === 'revealed');
  expect(revealed.players.map((p) => [p.name, p.vote])).toEqual([['Ann', '8'], ['Bob', '5']]);

  const { revision } = await ann.post('/finish', { points: 8 });
  expect(revision).toEqual({ id: expect.any(Number), from: 2, to: 8, by: 'Ann', at: expect.any(Number), status: 'synced', error: null });
  const done = await bobWs.until((r) => r.round === 'done' && story(r, 'FAKE-3').revisions[0]?.status === 'synced');
  expect(story(done, 'FAKE-3')).toMatchObject({ points: 8, jiraPoints: 8 });
  expect(done.timerStop).toEqual(expect.any(Number));
  expect(await jiraPoints(ann, 'FAKE-3')).toBe(8);

  await ann.post('/next');
  const next = await bobWs.until((r) => r.storyId === fake4.id);
  expect(next.round).toBe('voting');
  expect(next.players.map((p) => p.voted)).toEqual([false, false]);
  expect(await ann.fail('POST', '/next')).toEqual({ status: 409, error: 'There are no more stories in backlog' });
});

it('changes an estimate from the index and reverts it to null, writing Jira each time; Sync shows it in another session', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  const other = await create(app, { name: 'Bob', token: PAT });
  for (const moderator of [ann, other]) await moderator.post('/stories', { tickets: ['FAKE-2'] });
  const ws = await ann.live();
  const otherWs = await other.live();
  const fake2 = ws.room.stories[0];

  expect((await ann.post(`/stories/${fake2.id}/points`, { points: 5 })).revision).toMatchObject({ from: 1, to: 5, status: 'synced' });
  expect(await jiraPoints(ann, 'FAKE-2')).toBe(5);
  expect(otherWs.room.stories[0].jiraPoints).toBe(1);
  await other.post('/sync');
  expect((await otherWs.until((r) => r.stories[0].jiraPoints === 5)).stories[0].points).toBeNull();

  expect((await ann.post(`/stories/${fake2.id}/points`, { points: null })).revision).toMatchObject({ from: 5, to: null, status: 'synced' });
  expect(await jiraPoints(ann, 'FAKE-2')).toBeNull();
  const room = await ws.until((r) => r.stories[0].revisions.length === 2 && r.stories[0].revisions[0].status === 'synced');
  expect(room.stories[0]).toMatchObject({ points: null, jiraPoints: null });
  expect(room.stories[0].revisions.map((r) => [r.from, r.to, r.by])).toEqual([[5, null, 'Ann'], [1, 5, 'Ann']]);
});

it('writes changes to one ticket one at a time, in order', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-10'] });
  const ws = await ann.live();
  const { id } = ws.room.stories[0];

  const release = holdJira();
  const first = ann.post(`/stories/${id}/points`, { points: 5 });
  await ws.until((r) => r.stories[0].revisions.length === 1);
  const second = ann.post(`/stories/${id}/points`, { points: 8 });
  await ws.until((r) => r.stories[0].revisions.length === 2);
  release();
  expect((await first).revision).toMatchObject({ from: 2, to: 5, status: 'synced' });
  expect((await second).revision).toMatchObject({ from: 5, to: 8, status: 'synced' });
  expect(await jiraPoints(ann, 'FAKE-10')).toBe(8);
});

it('keeps the last known Jira value of a story whose write is pending when syncing', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  const bob = await create(app, { name: 'Bob', token: PAT }); // changes the same tickets in Jira meanwhile
  for (const moderator of [ann, bob]) await moderator.post('/stories', { tickets: ['FAKE-11', 'FAKE-12'] });
  for (const { id } of (await bob.live()).room.stories) await bob.post(`/stories/${id}/points`, { points: 8 });
  const ws = await ann.live();
  const fake11 = ws.room.stories[0];

  const release = holdJira();
  const write = ann.post(`/stories/${fake11.id}/points`, { points: 5 });
  await ws.until((r) => r.stories[0].revisions[0]?.status === 'pending');
  await ann.post('/sync');
  const synced = await ws.until((r) => r.stories[1].jiraPoints === 8);
  expect(synced.stories[0]).toMatchObject({ points: 5, jiraPoints: 3 });
  release();
  expect((await write).revision).toMatchObject({ from: 8, to: 5, status: 'synced' });
  expect((await ws.until((r) => r.stories[0].revisions[0].status === 'synced')).stories[0].jiraPoints).toBe(5);
});

it('keeps the value a write saved while a sync was reading Jira', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-17'] });
  const { id } = (await ann.live()).room.stories[0];

  // The sync reads Jira before the write, but its answer is handled after the write has settled.
  const callTool = Client.prototype.callTool;
  const read = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  vi.spyOn(Client.prototype, 'callTool').mockImplementationOnce(async function (this: Client, ...args) {
    const result = await callTool.apply(this, args);
    read.resolve();
    await answer.promise;
    return result;
  });
  const sync = ann.post('/sync');
  await read.promise;
  expect((await ann.post(`/stories/${id}/points`, { points: 8 })).revision).toMatchObject({ from: 2, to: 8, status: 'synced' });
  answer.resolve();
  await sync;
  expect((await ann.live()).room.stories[0].jiraPoints).toBe(8);
});

it('keeps the estimate but fails the revision when Jira refuses it (FAKE-13) or silently keeps its value (FAKE-14)', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-13', 'FAKE-14'] });
  const ws = await ann.live();
  const fake14 = ws.room.stories[1];

  await ann.post('/start', {});
  await ann.post('/reveal');
  const finished = await ann.post('/finish', { points: 8 }); // succeeds: the revision carries the failure
  expect(finished.revision).toMatchObject({
    from: 5, to: 8, status: 'failed', error: "Field 'customfield_10106' cannot be set. It is not on the appropriate screen, or unknown.",
  });
  expect((await ann.post(`/stories/${fake14.id}/points`, { points: 8 })).revision)
    .toMatchObject({ from: 0, to: 8, status: 'failed', error: 'Jira kept 0 instead of 8' });

  const room = await ws.until((r) => r.stories.every((s) => s.revisions[0]?.status === 'failed'));
  expect(room.stories.map((s) => [s.key, s.points, s.jiraPoints])).toEqual([['FAKE-13', 8, 5], ['FAKE-14', 8, 0]]);
  expect([await jiraPoints(ann, 'FAKE-13'), await jiraPoints(ann, 'FAKE-14')]).toEqual([5, 0]);

  // A refused write still counts once Jira holds the value.
  expect((await ann.post(`/stories/${room.stories[0].id}/points`, { points: 5 })).revision).toMatchObject({ from: 5, to: 5, status: 'synced' });
});

it('edits a ticket for everyone: only the moderator, only changed fields, the description as wiki markup', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-1', 'FAKE-14'] });
  const bob = await join(app, ann.id, 'Bob');
  const bobWs = await bob.live();
  const { id, description } = story(bobWs.room, 'FAKE-1');
  expect(description).toBe(FAKE1_DESCRIPTION);

  const updates = () =>
    calls.mock.calls.filter(([c]) => c.name === 'jira_update_issue').map(([c]) => Object.keys(JSON.parse(String(c.arguments?.fields))));
  const calls = vi.spyOn(Client.prototype, 'callTool');
  const wiki = '*As a* stakeholder,\n* fits one screen\n** no tables\nAsk [~AT01].';
  await ann.patch(`/stories/${id}`, { summary: ' Shorter sprint summary ', description: wiki });
  expect(await bobWs.until((r) => story(r, 'FAKE-1').summary === 'Shorter sprint summary').then((r) => story(r, 'FAKE-1').description)).toBe(wiki);
  const inJira = (await ann.get('/sprints/7001/issues') as Issue[]).find((i) => i.key === 'FAKE-1');
  expect(inJira).toMatchObject({ summary: 'Shorter sprint summary', description: wiki }); // bold and nested bullets intact
  await ann.patch(`/stories/${id}`, { summary: 'Short sprint summary' });
  expect(updates()).toEqual([['summary', 'Description'], ['summary']]);

  expect(await bob.fail('PATCH', `/stories/${id}`, { summary: 'Mine' })).toEqual({ status: 403, error: 'Only the moderator can do that' });
  expect(await ann.fail('PATCH', `/stories/${id}`, { summary: ' ' })).toEqual({ status: 400, error: 'Please enter a summary' });
  expect(await ann.fail('PATCH', `/stories/${id}`, {})).toEqual({ status: 400, error: 'Nothing to save' });
  const quiet = story(bobWs.room, 'FAKE-14');
  expect(await ann.fail('PATCH', `/stories/${quiet.id}`, { summary: 'Lost' })).toEqual({ status: 502, error: 'Jira kept the old text' });
  expect(story((await ann.live()).room, 'FAKE-14').summary).toBe(quiet.summary);

  const cy = await create(app, { name: 'Cy' });
  await cy.post('/stories', { tickets: ['Login page'] });
  const custom = (await cy.live()).room.stories[0];
  await cy.patch(`/stories/${custom.id}`, { summary: 'Login form', description: 'Email and password' });
  expect((await cy.live()).room.stories[0]).toMatchObject({ summary: 'Login form', description: 'Email and password' });
  expect(updates()).toHaveLength(3); // the custom edit made no Jira call
});

// Custom tickets have no Jira key, so any Jira call for them would fail: `synced` revisions show none was made.
it('keeps custom tickets and their estimates in the session, with no Jira routes', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  await ann.post('/stories', { tickets: [' Login page ', '', '  ', 'Logout'] });
  for (const tickets of [[], ['x'.repeat(201)], Array(101).fill('x')]) expect((await ann.fail('POST', '/stories', { tickets })).status).toBe(400);
  const ws = await ann.live();
  const custom = { id: expect.any(Number), key: null, description: '', type: '', status: '', url: null, jiraPoints: null, points: null, revisions: [] };
  expect(ws.room.stories).toEqual([{ ...custom, summary: 'Login page' }, { ...custom, summary: 'Logout' }]);
  const login = ws.room.stories[0];

  await ann.post('/start', {});
  await ann.post('/vote', { value: '3' });
  await ws.until((r) => r.round === 'revealed');
  expect((await ann.post('/finish', { points: 3 })).revision)
    .toEqual({ id: expect.any(Number), from: null, to: 3, by: 'Ann', at: expect.any(Number), status: 'synced', error: null });
  expect((await ann.post(`/stories/${login.id}/points`, { points: 5 })).revision).toMatchObject({ from: 3, to: 5, status: 'synced' });
  expect((await ann.post(`/stories/${login.id}/points`, { points: null })).revision).toMatchObject({ from: 5, to: null, status: 'synced' });

  const room = await ws.until((r) => r.stories[0].revisions.length === 3);
  expect(room.round).toBe('done');
  expect(room.stories[0]).toMatchObject({ points: null, jiraPoints: null });
  expect(room.stories[0].revisions.map((r) => [r.from, r.to])).toEqual([[5, null], [3, 5], [null, 3]]);
  for (const points of [-1, 1001, '3']) expect((await ann.fail('POST', `/stories/${login.id}/points`, { points })).status).toBe(400);

  const notJira = { status: 409, error: 'This session is not connected to Jira' };
  for (const [method, path] of [['GET', '/sprints'], ['GET', '/sprints/7001/issues'], ['POST', '/sync']] as const)
    expect(await ann.fail(method, path), path).toEqual(notJira);
});

it('enforces the round: start needs stories, votes only while voting and only cards of the deck', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  expect(await ann.fail('POST', '/start', {})).toEqual({ status: 409, error: 'Please first add stories' });

  await ann.post('/stories', { tickets: ['Login page', 'Logout'] });
  const ws = await ann.live();
  const logout = ws.room.stories[1];
  expect(await ann.fail('POST', '/vote', { value: '5' })).toEqual({ status: 409, error: 'Voting has not started' });
  for (const action of ['reveal', 'clear', 'timer']) expect((await ann.fail('POST', `/${action}`)).status, action).toBe(409);

  await ann.post('/start', { storyId: logout.id });
  expect((await ann.fail('POST', '/vote', { value: '21' })).status).toBe(400); // not a Scrum card
  await ann.post('/vote', { value: '½' }); // the only player online has voted
  const revealed = await ws.until((r) => r.round === 'revealed');
  expect(revealed.storyId).toBe(logout.id);
  expect(await ann.fail('POST', '/vote', { value: '1' })).toEqual({ status: 409, error: 'Vote cannot be changed once voting is completed' });
  expect((await ann.fail('POST', '/reveal')).status).toBe(409);

  await sleep(5);
  await ann.post('/timer');
  const reset = await ws.until((r) => r.timerStart! > revealed.timerStart!);
  expect(reset.round).toBe('revealed');
  await sleep(5);
  await ann.post('/clear');
  const cleared = await ws.until((r) => r.round === 'voting');
  expect(cleared.timerStart).toBeGreaterThan(reset.timerStart!);
  expect(player(cleared, 'Ann')).toMatchObject({ voted: false, vote: null });
});

it('deals the cards inside the point range, plus ? and coffee, and takes votes only on those', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', deck: 'fibonacci', min: 1, max: 13 });
  expect((await ann.live()).room.cards).toEqual(['1', '2', '3', '5', '8', '13', '?', '☕']);
  await ann.post('/stories', { tickets: ['Login page'] });
  await ann.post('/start', {});
  for (const value of ['0', '21']) expect(await ann.fail('POST', '/vote', { value }), value).toEqual({ status: 400, error: 'Invalid card' });
  await ann.post('/vote', { value: '13' });

  for (const range of [{ min: 5, max: 5 }, { min: 8, max: 3 }, { min: 14, max: 30 }]) {
    const res = await request(app, 'POST', '/api/rooms', { name: 'Bob', deck: 'fibonacci', ...range });
    expect([res.statusCode, res.json(), res.cookies], JSON.stringify(range)).toEqual([400, { error: 'Pick a wider point range' }, []]);
  }
});

it('moves through the stories: Start keeps the current open story, Next takes the next open one and wraps around', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  await ann.post('/stories', { tickets: ['A', 'B', 'C'] });
  const ws = await ann.live();
  const [a, b, c] = ws.room.stories.map((s) => s.id);

  await ann.post('/start', { storyId: b });
  await ann.post('/start', {});
  await ann.post('/next');
  await ws.until((r) => r.storyId === c);
  expect(await ann.fail('POST', '/finish', { points: 3 })).toEqual({ status: 409, error: 'Flip the cards first' });
  await ann.post('/next');
  await ws.until((r) => r.storyId === a);

  for (const id of [a, b, c]) await ann.post(`/stories/${id}/points`, { points: 1 });
  expect(await ann.fail('POST', '/start', {})).toEqual({ status: 409, error: 'There are no more stories in backlog' });
});

it('lets players become observers: they cannot vote, lose their vote, are listed last and stop holding up the flip', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  await ann.post('/stories', { tickets: ['Login page'] });
  const bob = await join(app, ann.id, 'Bob');
  const abe = await join(app, ann.id, 'Abe');
  const ws = await ann.live();
  await bob.live();
  await abe.live();
  await ann.post('/start', {});

  await abe.post('/vote', { value: '3' });
  await abe.post('/observer', { observer: true });
  const watching = await ws.until((r) => !!player(r, 'Abe')?.observer);
  expect(watching.players.map((p) => [p.name, p.observer, p.voted])).toEqual([['Ann', false, false], ['Bob', false, false], ['Abe', true, false]]);
  expect(await abe.fail('POST', '/vote', { value: '3' })).toEqual({ status: 403, error: 'Observers cannot vote' });

  await ann.post('/vote', { value: '5' });
  await bob.post('/observer', { observer: true }); // Ann is now the only player, and she has voted
  const revealed = await ws.until((r) => r.round === 'revealed');
  expect(revealed.players.map((p) => [p.name, p.vote])).toEqual([['Ann', '5'], ['Abe', null], ['Bob', null]]);
});

it('tracks presence: a voter who leaves stays listed, a player who leaves without voting drops off and stops holding up the flip', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  await ann.post('/stories', { tickets: ['Login page'] });
  const bob = await join(app, ann.id, 'Bob');
  const cy = await join(app, ann.id, 'Cy');
  const ws = await ann.live();
  const bobWs = await bob.live();
  const cyWs = await cy.live();
  await ann.post('/start', {});

  await bob.post('/vote', { value: '3' });
  bobWs.close();
  expect(player(await ws.until((r) => !player(r, 'Bob')?.online), 'Bob')).toMatchObject({ voted: true, vote: null });
  await ann.post('/vote', { value: '5' });
  cyWs.close();
  const revealed = await ws.until((r) => r.round === 'revealed');
  expect(revealed.players.map((p) => [p.name, p.online, p.vote])).toEqual([['Ann', true, '5'], ['Bob', false, '3']]);
});

it('drops a socket that stops answering pings, so the round no longer waits for that player', async () => {
  const app = await start();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const ann = await create(app, { name: 'Ann' });
  await ann.post('/stories', { tickets: ['Login page'] });
  const bob = await join(app, ann.id, 'Bob');
  const bobWs = await live(app, ann.id, bob.auth, false); // his laptop sleeps: no pong, no close
  await ann.post('/start', {});
  await ann.post('/vote', { value: '5' });

  vi.advanceTimersByTime(30_000);
  const ws = await ann.live();
  vi.advanceTimersByTime(30_000); // Bob never answered the first ping; Ann gets hers
  expect(await bobWs.closed).toBe(1006);
  expect((await ws.until((r) => r.round === 'revealed')).players.map((p) => [p.name, p.online])).toEqual([['Ann', true]]);
});

it('closes a socket that sends a frame over 1 KiB', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann' });
  const ws = socket(app, ann.id, ann.auth);
  ws.on('open', () => ws.send('x'.repeat(1025)));
  expect(await new Promise((resolve) => ws.on('close', resolve))).toBe(1009);
});

it('ends the session for everyone: sockets close with 4404, a Jira write in flight finishes, then Jira disconnects', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-16'] });
  const bob = await join(app, ann.id, 'Bob');
  const annWs = await ann.live();
  const bobWs = await bob.live();
  const closes = jiraCloses();

  const release = holdJira();
  const write = ann.post(`/stories/${annWs.room.stories[0].id}/points`, { points: 8 });
  await annWs.until((r) => r.stories[0].revisions[0]?.status === 'pending');
  const ended = ann.del();
  expect([await annWs.closed, await bobWs.closed]).toEqual([4404, 4404]);
  release();
  expect((await write).revision).toMatchObject({ from: 1, to: 8, status: 'synced' });
  await ended;
  expect(closes).toHaveBeenCalledOnce();
  const gone = { status: 404, error: 'Session not found' };
  expect(await ann.fail('GET', '/sprints')).toEqual(gone);
  expect(await bob.fail('POST', '/observer', { observer: true })).toEqual(gone);
  expect((await request(app, 'POST', `/api/rooms/${ann.id}/join`, { name: 'Cy' })).json()).toEqual({ error: 'Session not found' });
  expect(await closeCode(app, ann.id, ann.auth)).toBe(4404);
});

it('ends a session once nobody has been connected to it for 30 minutes', async () => {
  const app = await start();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const closes = jiraCloses();
  const exists = async (id: string) => (await request(app, 'POST', `/api/rooms/${id}/join`, { name: 'Cy' })).statusCode !== 404;
  const unused = await create(app, { name: 'Ann', token: PAT });
  const ended = await create(app, { name: 'Bob', token: PAT });
  await ended.del();
  const ann = await create(app, { name: 'Ann' });
  const ws = await ann.live();

  vi.advanceTimersByTime(30 * 60_000 - 1);
  expect(await exists(unused.id)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(await exists(unused.id)).toBe(false);
  expect(closes).toHaveBeenCalledTimes(2); // once each for the ended and the unused session: ending stopped the timer
  expect(await exists(ann.id)).toBe(true);

  ws.close();
  // The server notices the close a moment after the client, and only then starts counting.
  await vi.waitFor(async () => {
    vi.advanceTimersByTime(30 * 60_000);
    expect(await exists(ann.id)).toBe(false);
  });
});

it('ends every session on shutdown, once the requests in flight have been answered', async () => {
  const app = await start();
  const ann = await create(app, { name: 'Ann', token: PAT });
  await ann.post('/stories', { tickets: ['FAKE-15'] });
  const ws = await ann.live();
  const closes = jiraCloses();

  const release = holdJira();
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/rooms/${ann.id}/stories/${ws.room.stories[0].id}/points`;
  const write = fetch(url, { method: 'POST', headers: { ...ann.auth, 'content-type': 'application/json' }, body: '{"points":5}' });
  await ws.until((r) => r.stories[0].revisions[0]?.status === 'pending');
  const closed = app.close();
  expect(await ws.closed).toBe(1005);
  release();
  expect(await (await write).json()).toMatchObject({ revision: { from: 0.5, to: 5, status: 'synced' } });
  await closed; // at once, not when the keep-alive connection times out
  expect(closes).toHaveBeenCalledOnce();
});
