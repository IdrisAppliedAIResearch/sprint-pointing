import { randomBytes } from 'node:crypto';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cardPoints, DECKS, type DeckId, rangeCards, type Revision, type RoomView, type Round, type Story } from '../shared/protocol.ts';
import { createJira, type Jira, JiraUnreachable } from './jira.ts';

export type JiraConfig = { mcpUrl: string; url: string; boardId: string; field: string };

type Participant = { id: number; name: string; token: string; observer: boolean };
type Ticket = Omit<Story, 'url'> & { votes: Map<number, { value: string; at: number }> };
type Room = {
  id: string;
  cards: string[];
  moderator: number;
  participants: Participant[];
  stories: Ticket[];
  round: Round;
  storyId: number | null;
  timerStart: number | null;
  timerStop: number | null;
  jira: Jira | null;
  sockets: Map<WebSocket, number>;
  idle?: NodeJS.Timeout;
  seq: { story: number; revision: number };
};

const IDLE_MS = 30 * 60_000;
const Name = z.string().trim().min(1, 'Please enter your name').max(50);
const Points = z.number().min(0).max(1000);

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const badGateway = (e: Error): never => {
  throw httpError(502, e.message);
};

export function rooms(app: FastifyInstance, config: JiraConfig) {
  const sessions = new Map<string, Room>();

  // The sessions end once in-flight requests have finished, and those responses close their connection so the
  // shutdown doesn't wait out the keep-alive timeout.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onSend', async (_req, reply) => {
    if (closing) reply.header('connection', 'close');
  });
  app.addHook('onClose', async () => {
    await Promise.all([...sessions.values()].map(end));
  });

  function end(room: Room) {
    sessions.delete(room.id);
    clearTimeout(room.idle);
    for (const socket of room.sockets.keys()) socket.close(4404, 'not found');
    room.sockets.clear();
    return room.jira?.close();
  }

  // The moderator's browser holds a cookie, so they can always come back to the controls. Whoever joins by the invite
  // link gets a token that only their tab keeps (sent as a header, or as the WebSocket's second protocol), so every tab
  // is its own player, even in the moderator's browser.
  function whoami(room: Room, req: FastifyRequest) {
    const token = req.headers['x-participant'] ?? req.headers['sec-websocket-protocol']?.split(',')[1]?.trim() ?? req.cookies.participant;
    return room.participants.find((p) => p.token === token);
  }

  function join(room: Room, name: string) {
    const me = { id: room.participants.length + 1, name, token: randomBytes(32).toString('base64url'), observer: false };
    room.participants.push(me);
    return me;
  }

  function find(req: FastifyRequest) {
    const room = sessions.get((req.params as { id: string }).id);
    if (!room) throw httpError(404, 'Session not found');
    return room;
  }

  function participant(req: FastifyRequest) {
    const room = find(req);
    const me = whoami(room, req);
    if (!me) throw httpError(401, 'Join the session first');
    return { room, me };
  }

  function moderator(req: FastifyRequest) {
    const { room, me } = participant(req);
    if (me.id !== room.moderator) throw httpError(403, 'Only the moderator can do that');
    return { room, me };
  }

  function connected(room: Room) {
    if (!room.jira) throw httpError(409, 'This session is not connected to Jira');
    return room.jira;
  }

  function story(room: Room, id: number) {
    const found = room.stories.find((s) => s.id === id);
    if (!found) throw httpError(404, 'Story not found');
    return found;
  }

  function addStory(room: Room, ticket: Pick<Ticket, 'key' | 'summary' | 'description' | 'type' | 'status' | 'jiraPoints'>) {
    room.stories.push({ id: ++room.seq.story, ...ticket, points: null, votes: new Map(), revisions: [] });
  }

  const current = (room: Room) => room.stories.find((s) => s.id === room.storyId);

  function startVoting(room: Room, ticket: Ticket) {
    room.storyId = ticket.id;
    room.round = 'voting';
    room.timerStart = Date.now();
    room.timerStop = null;
    ticket.votes.clear();
  }

  function autoFlip(room: Room) {
    if (room.round !== 'voting') return;
    const online = new Set(room.sockets.values());
    const votes = current(room)!.votes;
    const voters = room.participants.filter((p) => online.has(p.id) && !p.observer);
    if (voters.length && voters.every((p) => votes.has(p.id))) room.round = 'revealed';
  }

  // Sends each socket its own snapshot: votes stay hidden until the reveal, except your own.
  function changed(room: Room) {
    const online = new Set(room.sockets.values());
    const votes = current(room)?.votes;
    const shown = room.round === 'revealed' || room.round === 'done';
    const players = room.participants
      .filter((p) => online.has(p.id) || votes?.has(p.id))
      .sort((a, b) => Number(a.observer) - Number(b.observer) || a.name.localeCompare(b.name));
    const stories = room.stories.map(({ votes: _, ...s }) => ({ ...s, url: s.key && `${config.url}/browse/${s.key}` }));
    for (const [socket, me] of room.sockets) {
      const view: RoomView = {
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
        players: players.map((p) => {
          const vote = votes?.get(p.id);
          return {
            id: p.id,
            name: p.name,
            online: online.has(p.id),
            observer: p.observer,
            voted: vote !== undefined,
            vote: vote && (shown || p.id === me) ? vote.value : null,
            votedAt: vote?.at ?? null,
          };
        }),
        stories,
      };
      socket.send(JSON.stringify(view));
    }
  }

  async function estimate(room: Room, ticket: Ticket, to: number | null, by: string) {
    const { jira } = room;
    const revision: Revision = {
      id: ++room.seq.revision,
      from: jira ? ticket.jiraPoints : ticket.points,
      to,
      by,
      at: Date.now(),
      status: jira ? 'pending' : 'synced',
      error: null,
    };
    ticket.revisions.unshift(revision);
    ticket.points = to;
    changed(room);
    if (!jira) return revision;
    try {
      revision.from = await jira.writePoints(ticket.key!, to);
      revision.status = 'synced';
      ticket.jiraPoints = to;
    } catch (e) {
      revision.status = 'failed';
      revision.error = (e as Error).message;
    }
    changed(room); // a no-op once the session has ended
    return revision;
  }

  app.post('/api/rooms', async (req, reply) => {
    const { name, deck, min, max, token } = z
      .object({
        name: Name,
        deck: z.enum(Object.keys(DECKS) as [DeckId]),
        min: Points.default(0),
        max: Points.default(1000),
        // Visible ASCII only: anything else would be rejected as a header value, in an error that quotes the token.
        token: z.string().trim().min(1, 'Please paste your Jira token').max(500).regex(/^[!-~]+$/, 'Please paste a valid Jira token').optional(),
      })
      .parse(req.body);
    const cards = rangeCards(deck, min, max);
    if (cards.filter((card) => cardPoints(card) !== null).length < 2) throw httpError(400, 'Pick a wider point range');
    const jira = token === undefined ? null : createJira({ ...config, token });
    if (jira) {
      await jira.sprints().catch(async (e: Error) => {
        await jira.close();
        throw e instanceof JiraUnreachable ? httpError(502, e.message) : httpError(400, `Jira rejected the token: ${e.message}`);
      });
    }
    const room: Room = {
      id: randomBytes(12).toString('base64url'),
      cards,
      moderator: 0,
      participants: [],
      stories: [],
      round: 'idle',
      storyId: null,
      timerStart: null,
      timerStop: null,
      jira,
      sockets: new Map(),
      seq: { story: 0, revision: 0 },
    };
    sessions.set(room.id, room);
    const me = join(room, name);
    room.moderator = me.id;
    reply.setCookie('participant', me.token, { path: `/api/rooms/${room.id}`, httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 86400 });
    room.idle = setTimeout(() => end(room), IDLE_MS);
    return { id: room.id };
  });

  app.post('/api/rooms/:id/join', async (req) => ({ token: join(find(req), z.object({ name: Name }).parse(req.body).name).token }));

  app.delete('/api/rooms/:id', async (req, reply) => {
    await end(moderator(req).room);
    return reply.code(204).send();
  });

  app.get('/api/rooms/:id/sprints', async (req) => connected(moderator(req).room).sprints().catch(badGateway));

  app.get('/api/rooms/:id/sprints/:sprintId/issues', async (req) => {
    const jira = connected(moderator(req).room);
    const { sprintId } = z.object({ sprintId: z.string().regex(/^\d+$/, 'Invalid sprint id') }).parse(req.params);
    return jira.sprintIssues(sprintId).catch(badGateway);
  });

  app.post('/api/rooms/:id/stories', async (req, reply) => {
    const { room } = moderator(req);
    if (room.jira) {
      const { tickets } = z.object({ tickets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'Invalid issue key')).min(1).max(100) }).parse(req.body);
      const found = await room.jira.issues(tickets).catch(badGateway);
      for (const key of tickets) {
        const issue = found.find((i) => i.key === key);
        if (issue && !room.stories.some((s) => s.key === key)) {
          addStory(room, { key, summary: issue.summary, description: issue.description, type: issue.type, status: issue.status, jiraPoints: issue.points });
        }
      }
    } else {
      const { tickets } = z.object({ tickets: z.array(z.string().trim().max(200)).min(1).max(100) }).parse(req.body);
      for (const title of tickets.filter(Boolean)) addStory(room, { key: null, summary: title, description: '', type: '', status: '', jiraPoints: null });
    }
    changed(room);
    return reply.code(204).send();
  });

  app.delete('/api/rooms/:id/stories/:storyId', async (req, reply) => {
    const { room } = moderator(req);
    const ticket = story(room, Number((req.params as { storyId: string }).storyId));
    room.stories.splice(room.stories.indexOf(ticket), 1);
    if (ticket.id === room.storyId) {
      room.round = 'idle';
      room.storyId = room.timerStart = room.timerStop = null;
    }
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/sync', async (req, reply) => {
    const { room } = moderator(req);
    // The read may predate a write that is pending or settles meanwhile: those stories keep their last known value.
    const text = (s: Ticket) => `${s.summary}\n${s.description}`;
    const before = new Map(room.stories.map((s) => [s, { revision: s.revisions[0]?.status === 'pending' ? null : s.revisions[0], text: text(s) }]));
    const found = await connected(room).issues(room.stories.map((s) => s.key!)).catch(badGateway);
    for (const ticket of room.stories) {
      const issue = found.find((i) => i.key === ticket.key);
      const was = before.get(ticket);
      if (!issue || !was) continue;
      Object.assign(ticket, { type: issue.type, status: issue.status });
      if (text(ticket) === was.text) Object.assign(ticket, { summary: issue.summary, description: issue.description });
      if (ticket.revisions[0] === was.revision) ticket.jiraPoints = issue.points;
    }
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/start', async (req, reply) => {
    const { room } = moderator(req);
    const { storyId } = z.object({ storyId: z.number().optional() }).parse(req.body);
    if (!room.stories.length) throw httpError(409, 'Please first add stories');
    const open = room.stories.filter((s) => s.points === null);
    const id = storyId ?? (open.find((s) => s.id === room.storyId) ?? open[0])?.id;
    if (id === undefined) throw httpError(409, 'There are no more stories in backlog');
    startVoting(room, story(room, id));
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/next', async (req, reply) => {
    const { room } = moderator(req);
    const i = room.stories.findIndex((s) => s.id === room.storyId);
    const next = [...room.stories.slice(i + 1), ...room.stories.slice(0, i + 1)].find((s) => s.points === null && s.id !== room.storyId);
    if (!next) throw httpError(409, 'There are no more stories in backlog');
    startVoting(room, next);
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/vote', async (req, reply) => {
    const { room, me } = participant(req);
    const { value } = z.object({ value: z.enum(room.cards, 'Invalid card') }).parse(req.body);
    if (me.observer) throw httpError(403, 'Observers cannot vote');
    if (room.round === 'idle') throw httpError(409, 'Voting has not started');
    if (room.round !== 'voting') throw httpError(409, 'Vote cannot be changed once voting is completed');
    current(room)!.votes.set(me.id, { value, at: Date.now() });
    autoFlip(room);
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/reveal', async (req, reply) => {
    const { room } = moderator(req);
    if (room.round !== 'voting') throw httpError(409, 'Voting is not in progress');
    room.round = 'revealed';
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/clear', async (req, reply) => {
    const { room } = moderator(req);
    if (room.round === 'idle') throw httpError(409, 'Voting has not started');
    startVoting(room, current(room)!);
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/timer', async (req, reply) => {
    const { room } = moderator(req);
    if (room.round !== 'voting' && room.round !== 'revealed') throw httpError(409, 'Voting is not in progress');
    room.timerStart = Date.now();
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/finish', async (req) => {
    const { room, me } = moderator(req);
    const { points } = z.object({ points: Points }).parse(req.body);
    if (room.round !== 'revealed') throw httpError(409, 'Flip the cards first');
    room.round = 'done';
    room.timerStop = Date.now();
    return { revision: await estimate(room, current(room)!, points, me.name) };
  });

  app.post('/api/rooms/:id/observer', async (req, reply) => {
    const { room, me } = participant(req);
    me.observer = z.object({ observer: z.boolean() }).parse(req.body).observer;
    if (me.observer) current(room)?.votes.delete(me.id);
    autoFlip(room);
    changed(room);
    return reply.code(204).send();
  });

  app.patch('/api/rooms/:id/stories/:storyId', async (req, reply) => {
    const { room } = moderator(req);
    const ticket = story(room, Number((req.params as { storyId: string }).storyId));
    const changes = z
      .object({ summary: z.string().trim().min(1, 'Please enter a summary').max(255).optional(), description: z.string().max(32_000).optional() })
      .refine((c) => c.summary !== undefined || c.description !== undefined, 'Nothing to save')
      .parse(req.body);
    if (ticket.key) await connected(room).edit(ticket.key, changes).catch(badGateway);
    Object.assign(ticket, changes);
    changed(room);
    return reply.code(204).send();
  });

  app.post('/api/rooms/:id/stories/:storyId/points', async (req) => {
    const { room, me } = moderator(req);
    const ticket = story(room, Number((req.params as { storyId: string }).storyId));
    const { points } = z.object({ points: Points.nullable() }).parse(req.body);
    return { revision: await estimate(room, ticket, points, me.name) };
  });

  app.get('/api/rooms/:id/live', { websocket: true }, (socket, req) => {
    const room = sessions.get((req.params as { id: string }).id);
    if (!room) return socket.close(4404, 'not found');
    const me = whoami(room, req);
    if (!me) return socket.close(4401, 'join');
    room.sockets.set(socket, me.id);
    clearTimeout(room.idle);
    // Pings keep proxies from closing a quiet socket, and drop one whose peer is gone (a laptop asleep).
    let alive = true;
    socket.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);
    socket.on('close', () => {
      clearInterval(beat);
      if (!room.sockets.delete(socket)) return; // the session ended
      autoFlip(room);
      changed(room);
      if (!room.sockets.size) room.idle = setTimeout(() => end(room), IDLE_MS);
    });
    changed(room);
  });
}
