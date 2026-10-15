import { z, ZodError } from 'zod';
import { cardPoints, DECKS, rangeCards, type DeckId, type Revision, type RoomView } from '../shared/protocol.ts';
import assets from './assets.json' with { type: 'json' };
import { decryptToken, encryptToken, randomToken } from './credentials.ts';
import { createJira, jiraOrigin } from './jira.ts';
import { addParticipant, database, heartbeat, identify, IDLE_MS, online, readRoom, requireModerator, withRoom } from './store.ts';
import { fail, type Database, type Environment, type Room, type Ticket } from './types.ts';

const Name = z.string().trim().min(1, 'Please enter your name').max(50);
const Points = z.number().min(0).max(1000);
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Invalid browser connection');
const current = (room: Room) => room.stories.find((ticket) => ticket.id === room.storyId);
const ticketById = (room: Room, id: string | number) => room.stories.find((ticket) => ticket.id === Number(id)) ?? fail(404, 'Story not found');
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const empty = (headers?: HeadersInit) => new Response(null, { status: 204, headers });

function startVoting(room: Room, ticket: Ticket) {
  room.storyId = ticket.id;
  room.round = 'voting';
  room.timerStart = Date.now();
  room.timerStop = null;
  ticket.votes = {};
}

function autoFlip(room: Room, connected: Set<number>) {
  if (room.round !== 'voting') return false;
  const voters = room.participants.filter((person) => connected.has(person.id) && !person.observer);
  if (!voters.length || !voters.every((person) => current(room)!.votes[person.id])) return false;
  room.round = 'revealed';
  return true;
}

function snapshot(room: Room, me: number, connected: Set<number>, env: Environment): RoomView {
  const votes = current(room)?.votes;
  const shown = room.round === 'revealed' || room.round === 'done';
  return {
    id: room.id,
    mode: room.jira ? 'jira' : 'custom',
    cards: room.cards,
    ownerId: room.moderator,
    me,
    now: Date.now(),
    round: room.round,
    storyId: room.storyId,
    timerStart: room.timerStart,
    timerStop: room.timerStop,
    players: room.participants.filter((person) => connected.has(person.id) || votes?.[person.id])
      .sort((first, second) => Number(first.observer) - Number(second.observer) || first.name.localeCompare(second.name))
      .map((person) => ({
        id: person.id,
        name: person.name,
        online: connected.has(person.id),
        observer: person.observer,
        voted: votes?.[person.id] !== undefined,
        vote: votes?.[person.id] && (shown || person.id === me) ? votes[person.id].value : null,
        votedAt: votes?.[person.id]?.at ?? null,
      })),
    stories: room.stories.map(({ votes: hiddenVotes, ...ticket }) => ({ ...ticket, url: ticket.key ? `${jiraOrigin(env)}/browse/${ticket.key}` : null })),
  };
}

async function body(request: Request) {
  if (!request.body) return {};
  if (Number(request.headers.get('content-length')) > 65_536) fail(413, 'Request is too large');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 65_536) {
      await reader.cancel();
      return fail(413, 'Request is too large');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    return fail(400, 'Please send valid JSON');
  }
}

async function live(request: Request, env: Environment, db: Database, roomId: string, url: URL) {
  if (request.headers.has('upgrade')) return fail(426, 'Use the hosted polling transport');
  let room: Room = JSON.parse((await readRoom(db, roomId)).body);
  const me = await identify(room, request);
  const clientId = ClientId.parse(url.searchParams.get('client'));
  await heartbeat(db, roomId, me.id, clientId);
  const connected = await online(db, roomId);
  if (autoFlip(room, connected)) {
    await withRoom(db, roomId, async (latest) => { autoFlip(latest, connected); });
    room = JSON.parse((await readRoom(db, roomId)).body);
  }
  return json(snapshot(room, me.id, connected, env));
}

async function create(request: Request, env: Environment, db: Database) {
  const { name, deck, min, max, token } = z.object({
    name: Name,
    deck: z.enum(Object.keys(DECKS) as [DeckId]),
    min: Points.default(0),
    max: Points.default(1000),
    token: z.string().trim().min(1, 'Please paste your Jira token').max(500).regex(/^[!-~]+$/, 'Please paste a valid Jira token').optional(),
  }).parse(await body(request));
  const cards = rangeCards(deck, min, max);
  if (cards.filter((card) => cardPoints(card) !== null).length < 2) fail(400, 'Pick a wider point range');
  const room: Room = { id: randomToken(12), cards, moderator: 1, participants: [], stories: [], round: 'idle', storyId: null, timerStart: null, timerStop: null, jira: token !== undefined, seq: { story: 0, revision: 0 } };
  const credential = token === undefined ? null : await encryptToken(token, room.id, env.SPRINT_SESSION_KEY);
  if (token !== undefined) await createJira(env, token).sprints();
  const { cookie } = await addParticipant(room, name);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM rooms WHERE expires_at <= ? AND lock_until <= ?').bind(now, now),
    db.prepare('INSERT INTO rooms (id, body, credential, expires_at) VALUES (?, ?, ?, ?)').bind(room.id, JSON.stringify(room), credential, now + IDLE_MS),
  ]);
  return json({ id: room.id }, 200, { 'set-cookie': cookie });
}

async function roomAction(request: Request, env: Environment, db: Database, roomId: string, path: string) {
  const data = request.method === 'GET' || request.method === 'DELETE' ? {} : await body(request);
  const row = await readRoom(db, roomId);
  const previous: Room = JSON.parse(row.body);
  const me = path === '/join' && request.method === 'POST' ? null : await identify(previous, request);
  if (me && !['/observer', '/vote', '/leave'].includes(path)) requireModerator(previous, me);
  if (path === '/leave' && request.method === 'POST') {
    const { clientId } = z.object({ clientId: ClientId }).parse(data);
    await db.prepare('DELETE FROM presence WHERE room_id = ? AND participant_id = ? AND client_id = ?').bind(roomId, me!.id, clientId).run();
    await withRoom(db, roomId, async (room) => { autoFlip(room, await online(db, roomId)); });
    return empty();
  }
  if (path === '' && request.method === 'DELETE') {
    await withRoom(db, roomId, async (room) => { requireModerator(room, me!); });
    const result = await db.prepare('DELETE FROM rooms WHERE id = ? AND lock_until = 0').bind(roomId).run();
    if (!result.meta.changes) fail(409, 'Another meeting action is in progress. Please try again.');
    return empty();
  }
  return withRoom(db, roomId, async (room, locked, save, renew) => {
    const connected = async () => {
      if (!room.jira || !locked.credential) return fail(409, 'This session is not connected to Jira');
      return createJira(env, await decryptToken(locked.credential, room.id, env.SPRINT_SESSION_KEY), renew);
    };
    const estimate = async (ticket: Ticket, points: number | null) => {
      const revision: Revision = { id: ++room.seq.revision, from: room.jira ? ticket.jiraPoints : ticket.points, to: points, by: me!.name, at: Date.now(), status: room.jira ? 'pending' : 'synced', error: null };
      ticket.points = points;
      ticket.revisions.unshift(revision);
      if (room.jira) {
        await save();
        try {
          revision.from = await (await connected()).writePoints(ticket.key!, points);
          revision.status = 'synced';
          ticket.jiraPoints = points;
        } catch (error) {
          revision.status = 'failed';
          revision.error = (error as Error).message;
        }
      }
      return json({ revision });
    };
    if (path === '/join' && request.method === 'POST') {
      const { token } = await addParticipant(room, z.object({ name: Name }).parse(data).name);
      return json({ token });
    }
    if (path === '/sprints' && request.method === 'GET') return json(await (await connected()).sprints());
    const sprint = /^\/sprints\/([^/]+)\/issues$/.exec(path);
    if (sprint && request.method === 'GET') return json(await (await connected()).sprintIssues(decodeURIComponent(sprint[1])));
    if (path === '/stories' && request.method === 'POST') {
      if (room.stories.length >= 1000) fail(409, 'This meeting has reached its story limit');
      const add = (ticket: Pick<Ticket, 'key' | 'summary' | 'description' | 'type' | 'status' | 'jiraPoints'>) => {
        if (room.stories.length >= 1000) fail(409, 'This meeting has reached its story limit');
        room.stories.push({ ...ticket, id: ++room.seq.story, points: null, revisions: [], votes: {} });
      };
      if (room.jira) {
        const { tickets } = z.object({ tickets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'Invalid issue key')).min(1).max(100) }).parse(data);
        const found = await (await connected()).issues(tickets);
        for (const key of tickets) {
          const issue = found.find((ticket) => ticket.key === key);
          if (issue && !room.stories.some((ticket) => ticket.key === key)) add({ key, summary: issue.summary, description: issue.description, type: issue.type, status: issue.status, jiraPoints: issue.points });
        }
      } else {
        const { tickets } = z.object({ tickets: z.array(z.string().trim().max(200)).min(1).max(100) }).parse(data);
        for (const summary of tickets.filter(Boolean)) add({ key: null, summary, description: '', type: '', status: '', jiraPoints: null });
      }
      return empty();
    }
    const storyPath = /^\/stories\/(\d+)(\/points)?$/.exec(path);
    if (storyPath) {
      const ticket = ticketById(room, storyPath[1]);
      if (request.method === 'DELETE' && !storyPath[2]) {
        room.stories.splice(room.stories.indexOf(ticket), 1);
        if (room.storyId === ticket.id) {
          room.round = 'idle';
          room.storyId = room.timerStart = room.timerStop = null;
        }
        return empty();
      }
      if (request.method === 'POST' && storyPath[2]) return estimate(ticket, z.object({ points: Points.nullable() }).parse(data).points);
      if (request.method === 'PATCH' && !storyPath[2]) {
        const changes = z.object({ summary: z.string().trim().min(1, 'Please enter a summary').max(255).optional(), description: z.string().max(32_000).optional() }).refine((value) => value.summary !== undefined || value.description !== undefined, 'Nothing to save').parse(data);
        if (ticket.key) await (await connected()).edit(ticket.key, changes);
        Object.assign(ticket, changes);
        return empty();
      }
    }
    if (request.method !== 'POST') return fail(404, 'Not found');
    if (path === '/sync') {
      const found = await (await connected()).issues(room.stories.map((ticket) => ticket.key!));
      for (const ticket of room.stories) {
        const issue = found.find((candidate) => candidate.key === ticket.key);
        if (issue) Object.assign(ticket, { summary: issue.summary, description: issue.description, type: issue.type, status: issue.status, jiraPoints: issue.points });
      }
    } else if (path === '/start') {
      if (!room.stories.length) fail(409, 'Please first add stories');
      const { storyId } = z.object({ storyId: z.number().optional() }).parse(data);
      const open = room.stories.filter((ticket) => ticket.points === null);
      const selected = storyId ?? (open.find((ticket) => ticket.id === room.storyId) ?? open[0])?.id;
      if (selected === undefined) fail(409, 'There are no more stories in backlog');
      startVoting(room, ticketById(room, selected));
    } else if (path === '/next') {
      const index = room.stories.findIndex((ticket) => ticket.id === room.storyId);
      const next = [...room.stories.slice(index + 1), ...room.stories.slice(0, index + 1)].find((ticket) => ticket.points === null && ticket.id !== room.storyId);
      if (!next) fail(409, 'There are no more stories in backlog');
      startVoting(room, next);
    } else if (path === '/vote') {
      const { value } = z.object({ value: z.enum(room.cards, 'Invalid card') }).parse(data);
      if (room.participants.find((person) => person.id === me!.id)!.observer) fail(403, 'Observers cannot vote');
      if (room.round === 'idle') fail(409, 'Voting has not started');
      if (room.round !== 'voting') fail(409, 'Vote cannot be changed once voting is completed');
      current(room)!.votes[me!.id] = { value, at: Date.now() };
      autoFlip(room, await online(db, roomId));
    } else if (path === '/reveal') {
      if (room.round !== 'voting') fail(409, 'Voting is not in progress');
      room.round = 'revealed';
    } else if (path === '/clear') {
      if (room.round === 'idle') fail(409, 'Voting has not started');
      startVoting(room, current(room)!);
    } else if (path === '/timer') {
      if (!['voting', 'revealed'].includes(room.round)) fail(409, 'Voting is not in progress');
      room.timerStart = Date.now();
    } else if (path === '/finish') {
      const { points } = z.object({ points: Points }).parse(data);
      if (room.round !== 'revealed') fail(409, 'Flip the cards first');
      room.round = 'done';
      room.timerStop = Date.now();
      return estimate(current(room)!, points);
    } else if (path === '/observer') {
      const latest = room.participants.find((person) => person.id === me!.id)!;
      latest.observer = z.object({ observer: z.boolean() }).parse(data).observer;
      if (latest.observer && current(room)) delete current(room)!.votes[latest.id];
      autoFlip(room, await online(db, roomId));
    } else return fail(404, 'Not found');
    return empty();
  });
}

async function dispatch(request: Request, env: Environment) {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method) || url.pathname.startsWith('/api/')) {
    const origin = request.headers.get('origin');
    if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Cross-origin requests are not allowed');
  }
  if (url.pathname === '/api/config' && request.method === 'GET') return json({ transport: 'poll', credentialStorage: 'encrypted', backend: 'sites' });
  if (url.pathname.startsWith('/api/')) {
    const db = database(env.DB);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      await db.prepare('SELECT COUNT(*) AS count FROM rooms').first();
      let jira: { reachable: boolean; status?: number } | undefined;
      if (url.searchParams.get('jira') === '1') {
        try {
          const response = await fetch(`${jiraOrigin(env)}/rest/api/2/serverInfo`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
          jira = { reachable: response.status === 200 || response.status === 401, status: response.status };
          await response.body?.cancel();
        } catch {
          jira = { reachable: false };
        }
      }
      return json({ backend: 'sites', storage: 'd1', localDependencies: false, ...(jira ? { jira } : {}) });
    }
    if (url.pathname === '/api/rooms' && request.method === 'POST') return create(request, env, db);
    const match = /^\/api\/rooms\/([A-Za-z0-9_-]{16})(\/.*)?$/.exec(url.pathname);
    if (!match) fail(404, 'Not found');
    if (match[2] === '/live' && request.method === 'GET') return live(request, env, db, match[1], url);
    return roomAction(request, env, db, match[1], match[2] ?? '');
  }
  if (!['GET', 'HEAD'].includes(request.method)) return fail(404, 'Not found');
  const files = assets as Record<string, { type: string; data: string; binary?: boolean }>;
  const asset = files[url.pathname] ?? (!url.pathname.startsWith('/assets/') ? files['/index.html'] : undefined);
  if (!asset) return fail(404, 'Not found');
  const content = request.method === 'HEAD' ? null : asset.binary ? Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0)) : asset.data;
  return new Response(content, { headers: { 'content-type': asset.type } });
}

export default {
  async fetch(request: Request, env: Environment) {
    let response: Response;
    try {
      response = await dispatch(request, env);
    } catch (error) {
      if (error instanceof ZodError) response = json({ error: error.issues[0].message }, 400);
      else {
        const known = error as Error & { statusCode?: number };
        response = json({ error: known.statusCode ? known.message : 'The hosted server could not complete this request. Please try again.' }, known.statusCode ?? 500);
      }
    }
    response.headers.set('cache-control', 'no-store');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  },
};
